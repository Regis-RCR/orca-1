import '../daemon/mock-descendant-sweep'
import { Terminal } from '@xterm/headless'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { composeAgentStatusEntry } from '../../shared/program-status/compose-agent-status-entry'
import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import { PROGRAM_STATUS_PROBE_REPLY } from '../../shared/pty-startup-program-status-probe'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from '../agent-hooks/server'
import { LEAF_1 } from '../agent-hooks/server.test-fixtures'
import {
  createMockSubprocess,
  startDaemonAdapterHarness
} from '../daemon/daemon-pty-adapter-test-harness'
import { Session } from '../daemon/session'
import { STARTUP_DA1_RESPONSE } from '../daemon/startup-device-attributes-responder'
import { createProgramStatusIngress } from './program-status-ingress'
import {
  createProgramStatusLocalIngest,
  installProgramStatusIngress
} from './program-status-local-ingest'

// A captured `claude-code` 2.1.295 turn (runtime/__fixtures__). Its startup write, in its real
// order: mode setup, XTVERSION, the Kitty keyboard query, the OSC 7501 support probe, then DA1. The
// agent only reports when the 7501 reply precedes DA1's; the rest of the turn is what it reports.
const TURN = readFileSync(
  join(__dirname, '..', 'runtime', '__fixtures__', 'claude-program-status-2-1-295-turn.txt'),
  'utf8'
)
const BATCH = TURN.slice(0, TURN.indexOf('\x1b[c') + 3)
const AFTER_BATCH = TURN.slice(BATCH.length)
// The same batch from a program that ends its probe with ST, the form a bare reply shares.
const ST_BATCH = BATCH.replace('\x1b]7501;?\x07', '\x1b]7501;?\x1b\\')
const PANE = makePaneKey('tab-1', LEAF_1)
const COLORS = { foreground: '#000000', background: '#ffffff' }
const DA1_REPLY = new RegExp(`^${String.fromCharCode(0x1b)}\\[\\?[\\d;]*c$`)

function intent(kitty: boolean): PtyStartupIngressIntent {
  return {
    colors: COLORS,
    ...(kitty ? { kittyKeyboardProtocol: true } : {}),
    deadlineMs: 5_000,
    programStatus: { ingest: true, answerProbe: true }
  }
}

/** The rest of the capture in PTY-sized reads. */
function reads(text: string): string[] {
  return Array.from({ length: Math.ceil(text.length / 64) }, (_, index) =>
    text.slice(index * 64, index * 64 + 64)
  )
}

/** The batch in one write, cut once at every offset, and one code unit per read. */
function deliveries(): string[][] {
  const cuts = Array.from({ length: BATCH.length - 1 }, (_, index) => [
    BATCH.slice(0, index + 1),
    BATCH.slice(index + 1)
  ])
  return [[BATCH], ...cuts, [...BATCH]]
}

/** The 7501 reply is written once, before the single DA1 reply, and the probe never travels on. */
function expectProbeAnsweredBeforeDa1(writes: readonly string[]): void {
  const probe = writes.indexOf(PROGRAM_STATUS_PROBE_REPLY)
  const da1 = writes.findIndex((write) => DA1_REPLY.test(write))
  expect(writes.filter((write) => write === PROGRAM_STATUS_PROBE_REPLY)).toHaveLength(1)
  expect(probe).toBeGreaterThanOrEqual(0)
  expect(da1).toBeGreaterThan(probe)
}

/** A later program in the same PTY probes again: each reply leads its own DA1 reply. */
function expectEachProbeAnsweredBeforeItsDa1(writes: readonly string[], count: number): void {
  const order = writes.flatMap((write) =>
    write === PROGRAM_STATUS_PROBE_REPLY ? ['7501'] : DA1_REPLY.test(write) ? ['da1'] : []
  )
  expect(order).toEqual(Array.from({ length: count }, () => ['7501', 'da1']).flat())
}

function hookServerSink(server: AgentHookServer) {
  return createProgramStatusIngress({
    sink: {
      report: (target, write) => server.ingestProgramStatusReport({ ...target, write }),
      lifecycle: (paneKey, write) => server.applyProgramStatusLifecycle(paneKey, write),
      rekey: (from, to, identity, current) =>
        server.rekeyProgramStatus(from, to, identity, current),
      forget: (paneKey, identity, options) => server.forgetProgramStatus(paneKey, identity, options)
    },
    resolveTarget: () => ({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }),
    resolvePaneKey: (paneKey) => server.resolveProgramStatusPaneKey(paneKey),
    now: () => Date.now()
  })
}

/** What every display reader shows for the pane: the store's slot through the composition. */
function composedAt(server: AgentHookServer) {
  const row = server.getProgramStatusSnapshot().find((entry) => entry.paneKey === PANE)
  const slot = row?.programStatus
    ? { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', slot: row.programStatus }
    : undefined
  return composeAgentStatusEntry(undefined, slot, 'hooks-first')
}

const flush = (viewer: Terminal) => new Promise<void>((resolve) => viewer.write('', resolve))

const viewers: Terminal[] = []
afterEach(() => {
  installProgramStatusIngress(null)
  for (const viewer of viewers.splice(0)) {
    viewer.dispose()
  }
})

/** The downstream renderer, which answers DA1 into the same PTY as the owner does. */
function viewer(onReply: (reply: string) => void): Terminal {
  const terminal = new Terminal({ cols: 80, rows: 24, allowProposedApi: true })
  terminal.onData(onReply)
  viewers.push(terminal)
  return terminal
}

describe('replaying the real startup batch through a local PTY owner', () => {
  async function run(chunks: readonly string[], kitty: boolean, awaitEachRead: boolean) {
    const writes: string[] = []
    const server = new AgentHookServer()
    const local = createProgramStatusLocalIngest(hookServerSink(server))
    local.begin('pty-1', 'inc-1')
    const renderer = viewer((reply) => writes.push(reply))
    const owner = new PtyStartupIngress({
      intent: intent(kitty),
      resolveHostColors: () => COLORS,
      write: (data) => writes.push(data),
      onEmission: (emission) => {
        // The runtime's data hook, then the renderer: both downstream of the owner.
        local.observe('pty-1', emission.data, Date.now())
        renderer.write(emission.data)
      }
    })
    for (const chunk of chunks) {
      owner.accept(chunk)
      if (awaitEachRead) {
        await flush(renderer)
      }
    }
    await flush(renderer)
    return { writes, server, local, owner, renderer }
  }

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true]
  ])(
    'writes the 7501 reply before the DA1 reply (kitty %s, renderer between reads %s)',
    async (kitty, awaitEachRead) => {
      for (const chunks of deliveries()) {
        const { writes } = await run(chunks, kitty, awaitEachRead)
        expectProbeAnsweredBeforeDa1(writes)
        if (kitty) {
          expect(writes.indexOf('\x1b[?0u')).toBeLessThan(
            writes.indexOf(PROGRAM_STATUS_PROBE_REPLY)
          )
        }
      }
    }
  )

  it('answers an ST probe from a later program in the same PTY', async () => {
    const { writes } = await run([BATCH, ST_BATCH], false, true)
    expectEachProbeAnsweredBeforeItsDa1(writes, 2)
  })

  it('then lands the captured turn in the store and the composed reader', async () => {
    const { server, owner } = await run([BATCH], true, false)
    const shown: string[] = []
    server.setProgramStatusListener((row) => {
      const aggregate = row.programStatus?.shown.summary.aggregate
      if (aggregate && shown.at(-1) !== aggregate) {
        shown.push(aggregate)
      }
    })
    for (const chunk of reads(AFTER_BATCH)) {
      owner.accept(chunk)
    }
    await vi.waitFor(() => expect(composedAt(server)).toMatchObject({ state: 'done' }), {
      timeout: 3_000,
      interval: 5
    })
    expect(shown).toEqual(['idle', 'working', 'done'])
    expect(server.getProgramStatusSnapshot()).toHaveLength(1)
    expect(composedAt(server)).toMatchObject({ paneKey: PANE, programStatusLive: true })
  })
})

describe('replaying the real startup batch through a daemon PTY owner (protocol 50)', () => {
  it('writes the 7501 reply before the attached renderer answers DA1, and reports reach the store', async () => {
    const subprocesses: ReturnType<typeof createMockSubprocess>[] = []
    const harness = await startDaemonAdapterHarness(() => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    })
    const server = new AgentHookServer()
    installProgramStatusIngress(hookServerSink(server))
    try {
      for (const [index, chunks] of deliveries().entries()) {
        const sessionId = `pty-${index}`
        const writes: string[] = []
        const renderer = viewer((reply) => harness.adapter.write(sessionId, reply))
        const off = harness.adapter.onData((event) => {
          if (event.id === sessionId && event.data.length > 0) {
            renderer.write(event.data)
          }
        })
        await harness.adapter.spawn({ sessionId, cols: 80, rows: 24, startupIngress: intent(true) })
        const subprocess = subprocesses.at(-1)!
        subprocess.write.mockImplementation((data) => writes.push(data))
        for (const chunk of chunks) {
          subprocess._simulateData(chunk)
        }
        await vi.waitFor(() => expect(writes.some((write) => DA1_REPLY.test(write))).toBe(true), {
          timeout: 3_000,
          interval: 5
        })
        expectProbeAnsweredBeforeDa1(writes)
        if (index === 0) {
          for (const chunk of reads(AFTER_BATCH)) {
            subprocess._simulateData(chunk)
          }
          await vi.waitFor(() => expect(composedAt(server)).toMatchObject({ state: 'done' }), {
            timeout: 3_000,
            interval: 5
          })
        }
        off()
      }
    } finally {
      harness.adapter.dispose()
      await harness.server.shutdown()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('answers an ST probe from a later program in the same daemon session', async () => {
    const subprocesses: ReturnType<typeof createMockSubprocess>[] = []
    const harness = await startDaemonAdapterHarness(() => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    })
    installProgramStatusIngress(hookServerSink(new AgentHookServer()))
    try {
      const writes: string[] = []
      const renderer = viewer((reply) => harness.adapter.write('pty-again', reply))
      const off = harness.adapter.onData((event) => {
        if (event.id === 'pty-again' && event.data.length > 0) {
          renderer.write(event.data)
        }
      })
      await harness.adapter.spawn({
        sessionId: 'pty-again',
        cols: 80,
        rows: 24,
        startupIngress: intent(false)
      })
      const subprocess = subprocesses.at(-1)!
      subprocess.write.mockImplementation((data) => writes.push(data))
      for (const [round, batch] of [BATCH, ST_BATCH].entries()) {
        subprocess._simulateData(batch)
        await vi.waitFor(
          () => expect(writes.filter((write) => DA1_REPLY.test(write))).toHaveLength(round + 1),
          { timeout: 3_000, interval: 5 }
        )
      }
      expectEachProbeAnsweredBeforeItsDa1(writes, 2)
      off()
    } finally {
      harness.adapter.dispose()
      await harness.server.shutdown()
      rmSync(harness.dir, { recursive: true, force: true })
    }
  }, 60_000)

  it.each([false, true])(
    'stays ahead of the daemon DA1 answer while the shell-ready barrier holds (split %s)',
    async (split) => {
      for (const chunks of split ? deliveries().slice(1) : [[BATCH]]) {
        const subprocess = createMockSubprocess()
        const writes: string[] = []
        subprocess.write.mockImplementation((data) => writes.push(data))
        const session = new Session({
          sessionId: 'barrier',
          cols: 80,
          rows: 24,
          subprocess,
          shellReadySupported: true,
          startupIngress: intent(false)
        })
        try {
          for (const chunk of chunks) {
            subprocess._simulateData(chunk)
          }
          await vi.waitFor(() => expect(writes).toContain(STARTUP_DA1_RESPONSE), {
            timeout: 3_000,
            interval: 5
          })
          expectProbeAnsweredBeforeDa1(writes)
        } finally {
          session.dispose()
        }
      }
    },
    60_000
  )
})
