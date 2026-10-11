/**
 * The captured `claude-code` 2.1.295 transcripts (`runtime/__fixtures__/claude-program-status-*`)
 * replayed through a daemon PTY at protocol 50: the daemon tracks the real bytes, relays facts, and
 * main lands them in the hook server's slot, a backgrounded session and an app restart included.
 */
import '../daemon/mock-descendant-sweep'
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from '../daemon/daemon-pty-adapter-test-harness'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type * as StartupIngressModule from '../../shared/pty-startup-ingress'
import type { ProgramStatusSummaryState } from '../../shared/program-status/program-status-slot'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from '../agent-hooks/server'
import { LEAF_1 } from '../agent-hooks/server.test-fixtures'
import { createProgramStatusIngress } from './program-status-ingress'
import { installProgramStatusIngress } from './program-status-local-ingest'

// Why: the admission parser does not keep the field yet; this lets the intent reach the session
// past it, exactly as it will once the parser keeps it.
vi.mock('../../shared/pty-startup-ingress', async (importOriginal) => {
  const actual = await importOriginal<typeof StartupIngressModule>()
  return {
    ...actual,
    parsePtyStartupIngressIntent: (value: unknown) => {
      const parsed = actual.parsePtyStartupIngressIntent(value)
      const asked =
        typeof value === 'object' && value !== null && 'programStatus' in value
          ? value.programStatus
          : undefined
      const ingest =
        typeof asked === 'object' && asked !== null && 'ingest' in asked && asked.ingest === true
      return parsed && ingest ? { ...parsed, programStatus: { ingest: true as const } } : parsed
    }
  }
})

const PTY = 'pty-1'
const PANE = makePaneKey('tab-1', LEAF_1)
const READ_SIZE = 64
const ARMED: PtyStartupIngressIntent = {
  colors: { foreground: '#000000', background: '#ffffff' },
  deadlineMs: 1_000,
  programStatus: { ingest: true }
}

type Scenario = 'startup' | 'turn' | 'permission' | 'question' | 'interrupt' | 'subagent'

function transcript(scenario: Scenario): string {
  const name = `claude-program-status-2-1-295-${scenario}.txt`
  return readFileSync(join(__dirname, '..', 'runtime', '__fixtures__', name), 'utf8')
}

function reads(text: string): string[] {
  const chunks: string[] = []
  for (let offset = 0; offset < text.length; offset += READ_SIZE) {
    chunks.push(text.slice(offset, offset + READ_SIZE))
  }
  return chunks
}

/** One main process: the hook server and the ingress over it, installed the way startup does. */
function installMain() {
  const server = new AgentHookServer()
  const shown: (ProgramStatusSummaryState | null)[] = []
  server.setProgramStatusListener((row) => {
    const aggregate = row.programStatus?.shown.summary.aggregate ?? null
    if (shown.at(-1) !== aggregate) {
      shown.push(aggregate)
    }
  })
  installProgramStatusIngress(
    createProgramStatusIngress({
      sink: {
        report: (target, write) => server.ingestProgramStatusReport({ ...target, write }),
        lifecycle: (paneKey, write) => server.applyProgramStatusLifecycle(paneKey, write),
        rekey: (from, to, identity, current) =>
          server.rekeyProgramStatus(from, to, identity, current),
        forget: (paneKey, identity, options) =>
          server.forgetProgramStatus(paneKey, identity, options)
      },
      resolveTarget: (ptyId) => (ptyId === PTY ? { paneKey: PANE } : undefined),
      resolvePaneKey: (paneKey) => server.resolveProgramStatusPaneKey(paneKey),
      now: () => Date.now()
    })
  )
  const slot = () =>
    server.getProgramStatusSnapshot().find((row) => row.paneKey === PANE)?.programStatus
  return { server, shown, slot }
}

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 5_000, interval: 5 })
}

describe('captured agent transcripts through a daemon PTY (protocol 50)', () => {
  let harness: DaemonAdapterHarness
  let subprocesses: ReturnType<typeof createMockSubprocess>[]
  let main: ReturnType<typeof installMain>
  const adapters: DaemonPtyAdapter[] = []

  beforeEach(async () => {
    subprocesses = []
    harness = await startDaemonAdapterHarness(() => {
      const subprocess = createMockSubprocess()
      subprocesses.push(subprocess)
      return subprocess
    })
    adapters.push(harness.adapter)
    main = installMain()
  })

  afterEach(async () => {
    installProgramStatusIngress(null)
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  })

  const emit = (chunks: readonly string[]) => {
    for (const chunk of chunks) {
      subprocesses.at(-1)!._simulateData(chunk)
    }
  }

  it.each([
    ['startup', ['idle']],
    ['turn', ['idle', 'working', 'done']],
    ['permission', ['idle', 'working', 'blocked', 'working', 'done']],
    ['question', ['idle', 'working', 'question', 'working', 'done']],
    ['interrupt', ['idle', 'working', 'idle']],
    ['subagent', ['idle', 'working', 'done', null]]
  ] as const)('%s: the slot shows each real transition', async (scenario, transitions) => {
    await harness.adapter.spawn({ sessionId: PTY, cols: 120, rows: 40, startupIngress: ARMED })
    emit(reads(transcript(scenario)))
    await until(() => main.shown.length === transitions.length)
    expect(main.shown).toEqual(transitions)
  })

  it('a backgrounded session still lands every transition', async () => {
    await harness.adapter.spawn({ sessionId: PTY, cols: 120, rows: 40, startupIngress: ARMED })
    harness.adapter.setPtyBackgrounded(PTY, true)
    // The notify is one-way; let it reach the daemon before the agent writes.
    await new Promise((resolve) => setTimeout(resolve, 50))
    emit(reads(transcript('permission')))
    await until(() => main.shown.at(-1) === 'done')
    expect(main.shown).toEqual(['idle', 'working', 'blocked', 'working', 'done'])
  })

  it('a turn that finished while the app was closed shows from the reply snapshot', async () => {
    await harness.adapter.spawn({ sessionId: PTY, cols: 120, rows: 40, startupIngress: ARMED })
    const text = transcript('question')
    const blockedAt = text.indexOf('\x1b]7501;state=blocked')
    const blockedEnd = text.indexOf('\x07', blockedAt) + 1
    emit(reads(text.slice(0, blockedEnd)))
    await until(() => main.slot()?.shown.summary.aggregate === 'question')
    harness.adapter.dispose()
    // The user answers while no client is attached; the daemon keeps tracking.
    emit(reads(text.slice(blockedEnd)))

    const adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    adapters.push(adapter)
    await adapter.spawn({ sessionId: PTY, cols: 120, rows: 40, attachOnly: true })
    expect(main.slot()).toMatchObject({ liveness: 'live' })
    expect(main.slot()?.shown.summary.aggregate).toBe('done')
  })
})
