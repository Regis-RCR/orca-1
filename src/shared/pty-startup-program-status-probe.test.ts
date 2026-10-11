import { describe, expect, it } from 'vitest'
import {
  PROGRAM_STATUS_PROBE_REPLY,
  parseProgramStatusProbe
} from './pty-startup-program-status-probe'
import { parsePtyStartupQuery } from './pty-startup-query'
import { parseProgramStatusReport } from './program-status/program-status-report'

const BEL_PROBE = '\x1b]7501;?\x07'
const ST_PROBE = '\x1b]7501;?\x1b\\'

describe('parseProgramStatusProbe', () => {
  it('replies with the default states and kinds spelled out, ST-terminated', () => {
    expect(PROGRAM_STATUS_PROBE_REPLY).toBe(
      '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'
    )
  })

  it('is never itself a probe, so its own verbatim echo cannot pass for one', () => {
    for (let at = 0; at < PROGRAM_STATUS_PROBE_REPLY.length; at += 1) {
      expect(parseProgramStatusProbe(PROGRAM_STATUS_PROBE_REPLY, at).kind).not.toBe(
        'program-status'
      )
    }
  })

  it('lists only states and kinds the report parser accepts', () => {
    const pairs = PROGRAM_STATUS_PROBE_REPLY.slice('\x1b]7501;?:'.length, -2).split(':')
    const lists = Object.fromEntries(pairs.map((pair) => pair.split('=')))
    for (const state of lists.states.split(',')) {
      const body = state === 'blocked' ? 'state=blocked:kind=question' : `state=${state}`
      expect(parseProgramStatusReport(body).kind, state).toBe('report')
    }
    for (const kind of lists.kinds.split(',')) {
      expect(parseProgramStatusReport(`state=blocked:kind=${kind}`), kind).toMatchObject({
        kind: 'report',
        report: { kind }
      })
    }
  })

  it.each([
    ['BEL', BEL_PROBE],
    ['ST', ST_PROBE]
  ])('recognizes a %s-terminated probe at any offset', (_name, probe) => {
    expect(parseProgramStatusProbe(probe, 0)).toEqual({
      kind: 'program-status',
      endIndex: probe.length
    })
    expect(parseProgramStatusProbe(`ab${probe}\x1b[c`, 2)).toEqual({
      kind: 'program-status',
      endIndex: 2 + probe.length
    })
  })

  it('ends a probe at a bare ESC without consuming it, as the scanner does', () => {
    expect(parseProgramStatusProbe('\x1b]7501;?\x1b[c', 0)).toEqual({
      kind: 'program-status',
      endIndex: '\x1b]7501;?'.length
    })
  })

  it('holds every strict prefix as partial, the trailing ESC included', () => {
    for (const probe of [BEL_PROBE, ST_PROBE]) {
      for (let cut = 1; cut < probe.length; cut += 1) {
        expect(parseProgramStatusProbe(probe.slice(0, cut), 0)).toEqual({ kind: 'partial' })
      }
    }
  })

  it.each([
    '\x1b]7501;state=working\x07',
    '\x1b]7501;?x\x07',
    '\x1b]7501;??\x07',
    '\x1b]75010;?\x07',
    '\x1b]10;?\x07',
    'plain text'
  ])('is not a probe: %j', (data) => {
    expect(parseProgramStatusProbe(data, 0)).toEqual({ kind: 'none' })
  })
})

describe('parsePtyStartupQuery with the probe authority', () => {
  it('recognizes the probe only when the owner answers it', () => {
    expect(parsePtyStartupQuery(BEL_PROBE, 0, false, true)).toEqual({
      kind: 'program-status',
      endIndex: BEL_PROBE.length
    })
    expect(parsePtyStartupQuery(BEL_PROBE, 0, false, false)).toEqual({ kind: 'none' })
    expect(parsePtyStartupQuery(BEL_PROBE, 0, false)).toEqual({ kind: 'none' })
  })

  it('keeps an ambiguous OSC prefix partial for both colour and probe', () => {
    for (const prefix of ['\x1b', '\x1b]', '\x1b]7', '\x1b]1']) {
      expect(parsePtyStartupQuery(prefix, 0, false, true).kind).toBe('partial')
    }
    expect(parsePtyStartupQuery('\x1b]7', 0, false, false).kind).toBe('none')
  })

  it('still answers colour queries beside it, and the Kitty query first while open', () => {
    expect(parsePtyStartupQuery('\x1b]10;?\x07', 0, false, true).kind).toBe('match')
    expect(parsePtyStartupQuery('\x1b[?u', 0, true, true).kind).toBe('kitty')
  })
})
