import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress, parsePtyStartupIngressIntent } from './pty-startup-ingress'
import type { PtyStartupIngressIntent } from './pty-startup-ingress-intent'
import { PROGRAM_STATUS_PROBE_REPLY } from './pty-startup-program-status-probe'

const COLORS = { foreground: '#2e3434', background: '#ffffff' }
const ANSWERING: PtyStartupIngressIntent = {
  colors: COLORS,
  deadlineMs: 5_000,
  programStatus: { ingest: true, answerProbe: true }
}
const PROBE = '\x1b]7501;?\x07'
const DA1 = '\x1b[c'

/** One ordered log of what the owner wrote to the PTY and what it passed downstream. */
function harness(intent: PtyStartupIngressIntent | null | undefined = ANSWERING) {
  const log: string[] = []
  const ingress = new PtyStartupIngress({
    ...(intent ? { intent } : {}),
    resolveHostColors: () => COLORS,
    write: (data) => log.push(`write:${data}`),
    onEmission: (emission) => {
      if (emission.data.length > 0) {
        log.push(`emit:${emission.data}`)
      }
    }
  })
  const writes = () => log.filter((entry) => entry.startsWith('write:')).map((e) => e.slice(6))
  const emitted = () =>
    log
      .filter((entry) => entry.startsWith('emit:'))
      .map((e) => e.slice(5))
      .join('')
  return { ingress, log, writes, emitted }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the owner answers the OSC 7501 support probe', () => {
  it.each([
    ['BEL', PROBE],
    ['ST', '\x1b]7501;?\x1b\\']
  ])('answers a %s probe once, strips it, and passes the rest on', (_name, probe) => {
    const { ingress, writes, emitted } = harness()
    ingress.accept(`before${probe}after`)
    expect(writes()).toEqual([PROGRAM_STATUS_PROBE_REPLY])
    expect(emitted()).toBe('beforeafter')
  })

  it('writes the reply before the DA1 bytes behind it leave the owner', () => {
    const { ingress, log } = harness()
    ingress.accept(`${PROBE}${DA1}`)
    expect(log).toEqual([`write:${PROGRAM_STATUS_PROBE_REPLY}`, `emit:${DA1}`])
  })

  it.each([
    ['no intent', null],
    ['ingestion alone', { colors: COLORS, deadlineMs: 5_000, programStatus: { ingest: true } }],
    [
      'the relay, whose parser refuses the field',
      parsePtyStartupIngressIntent(ANSWERING, { programStatus: false })
    ]
  ] as const)('never answers with %s, and passes the probe through raw', (_name, intent) => {
    const { ingress, writes, emitted } = harness(intent)
    ingress.accept(`${PROBE}${DA1}`)
    expect(writes()).toEqual([])
    expect(emitted()).toBe(`${PROBE}${DA1}`)
  })

  it('answers for the whole session, minutes after startup', () => {
    const { ingress, writes } = harness()
    vi.advanceTimersByTime(10 * 60_000)
    ingress.closeQueryAuthority()
    ingress.accept(PROBE)
    expect(writes()).toEqual([PROGRAM_STATUS_PROBE_REPLY])
  })

  it('keeps answering colour queries in the same batch, in source order', () => {
    const { ingress, writes } = harness()
    ingress.accept(`\x1b]10;?\x07${PROBE}`)
    expect(writes()).toEqual(['\x1b]10;rgb:2e2e/3434/3434\x1b\\', PROGRAM_STATUS_PROBE_REPLY])
  })
})

const ST_PROBE = '\x1b]7501;?\x1b\\'
const REPLY = PROGRAM_STATUS_PROBE_REPLY
// The three shapes a tty or line editor echoes a reply in; see pty-startup-reply-echo-shapes.ts.
const ECHOES = [
  ['verbatim', REPLY],
  ['ECHOCTL caret', REPLY.replaceAll('\x1b', '^[')],
  ['readline', REPLY.replaceAll('\x1b]', '\x07').replaceAll('\x1b\\', '')]
] as const

describe('every probe of a session is answered, and only real echoes are swallowed', () => {
  it.each([
    ['ST then ST', ST_PROBE, ST_PROBE],
    ['ST then BEL', ST_PROBE, PROBE],
    ['BEL then ST', PROBE, ST_PROBE],
    ['BEL then BEL', PROBE, PROBE]
  ])('answers a second probe, %s, each before its own DA1', (_name, first, second) => {
    const { ingress, log, emitted } = harness()
    ingress.accept(`${first}${DA1}`)
    ingress.accept(`${second}${DA1}`)
    expect(log).toEqual([`write:${REPLY}`, `emit:${DA1}`, `write:${REPLY}`, `emit:${DA1}`])
    expect(emitted()).toBe(`${DA1}${DA1}`)
  })

  it('answers three probes in one read', () => {
    const { ingress, writes, emitted } = harness()
    ingress.accept(`${ST_PROBE}${DA1}${PROBE}${DA1}${ST_PROBE}${DA1}`)
    expect(writes()).toEqual([REPLY, REPLY, REPLY])
    expect(emitted()).toBe(`${DA1}${DA1}${DA1}`)
  })

  it.each([
    ['ST', ST_PROBE],
    ['BEL', PROBE]
  ])('answers a second %s probe cut at every offset of its read', (_name, probe) => {
    const second = `${probe}${DA1}`
    for (let cut = 0; cut <= second.length; cut += 1) {
      const { ingress, writes, emitted } = harness()
      ingress.accept(`${ST_PROBE}${DA1}`)
      ingress.accept(second.slice(0, cut))
      ingress.accept(second.slice(cut))
      expect(writes(), `cut ${cut}`).toEqual([REPLY, REPLY])
      expect(emitted(), `cut ${cut}`).toBe(`${DA1}${DA1}`)
    }
  })

  it('answers two probes fed one code unit per read', () => {
    const { ingress, writes, emitted } = harness()
    for (const unit of `${ST_PROBE}${DA1}${PROBE}${DA1}`) {
      ingress.accept(unit)
    }
    expect(writes()).toEqual([REPLY, REPLY])
    expect(emitted()).toBe(`${DA1}${DA1}`)
  })

  it.each(ECHOES)('swallows the %s echo of a reply and never answers it', (_name, echo) => {
    const { ingress, writes, emitted } = harness()
    ingress.accept(`${ST_PROBE}${DA1}`)
    ingress.accept(`out${echo}put`)
    expect(writes()).toEqual([REPLY])
    expect(emitted()).toBe(`${DA1}output`)
  })

  it.each(ECHOES.slice(1))('swallows the %s echo cut at every offset', (_name, echo) => {
    for (let cut = 1; cut < echo.length; cut += 1) {
      const { ingress, writes, emitted } = harness()
      ingress.accept(`${ST_PROBE}${DA1}`)
      ingress.accept(`out${echo.slice(0, cut)}`)
      ingress.accept(`${echo.slice(cut)}put`)
      expect(writes(), `cut ${cut}`).toEqual([REPLY])
      expect(emitted(), `cut ${cut}`).toBe(`${DA1}output`)
    }
  })

  // Why: a verbatim echo is matched only whole, so a torn one passes on; it must not loop back.
  it('never answers a torn verbatim echo as a probe', () => {
    for (let cut = 1; cut < REPLY.length; cut += 1) {
      const { ingress, writes } = harness()
      ingress.accept(`${ST_PROBE}${DA1}`)
      ingress.accept(REPLY.slice(0, cut))
      ingress.accept(REPLY.slice(cut))
      expect(writes(), `cut ${cut}`).toEqual([REPLY])
    }
  })

  it('swallows the echo of the first reply and still answers the probe behind it', () => {
    const { ingress, writes, emitted } = harness()
    ingress.accept(`${ST_PROBE}${DA1}`)
    ingress.accept(`${REPLY}${ST_PROBE}${DA1}`)
    expect(writes()).toEqual([REPLY, REPLY])
    expect(emitted()).toBe(`${DA1}${DA1}`)
  })
})

describe('a torn probe and the 500 ms hold', () => {
  it('answers a probe completed 499 ms after its first fragment', () => {
    const { ingress, writes, emitted } = harness()
    ingress.accept('\x1b]7501;')
    vi.advanceTimersByTime(499)
    ingress.accept(`?\x07${DA1}`)
    expect(writes()).toEqual([PROGRAM_STATUS_PROBE_REPLY])
    expect(emitted()).toBe(DA1)
  })

  it('releases a fragment raw at 500 ms and never answers its late completion', () => {
    const { ingress, writes, emitted } = harness()
    ingress.accept('\x1b]7501;')
    vi.advanceTimersByTime(500)
    expect(emitted()).toBe('\x1b]7501;')
    ingress.accept(`?\x07${DA1}`)
    expect(writes()).toEqual([])
    expect(emitted()).toBe(`\x1b]7501;?\x07${DA1}`)
  })

  it('never answers a fragment older than 500 ms, even when each read renewed the hold', () => {
    const { ingress, writes, emitted } = harness()
    ingress.accept('\x1b]75')
    vi.advanceTimersByTime(300)
    ingress.accept('01;')
    vi.advanceTimersByTime(300)
    ingress.accept(`?\x07${DA1}`)
    expect(writes()).toEqual([])
    expect(emitted()).toBe(`${PROBE}${DA1}`)
  })

  it('dates a new probe from its own start, not from an earlier disproven fragment', () => {
    const { ingress, writes } = harness()
    ingress.accept('\x1b]7')
    vi.advanceTimersByTime(400)
    ingress.accept('x \x1b]7501;')
    vi.advanceTimersByTime(400)
    ingress.accept('?\x07')
    expect(writes()).toEqual([PROGRAM_STATUS_PROBE_REPLY])
  })
})
