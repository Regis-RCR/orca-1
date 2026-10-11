import '../daemon/mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rmSync } from 'node:fs'
import type { Socket } from 'node:net'
import { DaemonClient } from '../daemon/client'
import { DaemonPtyAdapter } from '../daemon/daemon-pty-adapter'
import {
  createMockSubprocess,
  startDaemonAdapterHarness,
  type DaemonAdapterHarness
} from '../daemon/daemon-pty-adapter-test-harness'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type * as StartupIngressModule from '../../shared/pty-startup-ingress'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from '../agent-hooks/server'
import { LEAF_1 } from '../agent-hooks/server.test-fixtures'
import {
  createProgramStatusIngress,
  type ProgramStatusIngress,
  type ProgramStatusIngressTarget
} from './program-status-ingress'
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
const ARMED: PtyStartupIngressIntent = {
  colors: { foreground: '#000000', background: '#ffffff' },
  deadlineMs: 1_000,
  programStatus: { ingest: true }
}
const report = (body: string): string => `\x1b]7501;${body}\x07`

type Subprocess = ReturnType<typeof createMockSubprocess>

/** One main process: a hook server and the ingress over it, installed the way startup does. */
function installMain(options: { attributed?: boolean } = {}) {
  const server = new AgentHookServer()
  const ops: string[] = []
  const calls: string[] = []
  const targets = new Map<string, ProgramStatusIngressTarget>(
    options.attributed === false ? [] : [[PTY, { paneKey: PANE }]]
  )
  const inner = createProgramStatusIngress({
    sink: {
      report: (target, write) => (
        ops.push('report'),
        server.ingestProgramStatusReport({ ...target, write })
      ),
      lifecycle: (paneKey, write) => (
        ops.push(`lifecycle:${write.liveness}`),
        server.applyProgramStatusLifecycle(paneKey, write)
      ),
      rekey: (from, to, identity, current) =>
        server.rekeyProgramStatus(from, to, identity, current),
      forget: (paneKey, identity, options) => (
        ops.push('forget'),
        server.forgetProgramStatus(paneKey, identity, options)
      )
    },
    resolveTarget: (ptyId) => targets.get(ptyId),
    resolvePaneKey: (paneKey) => server.resolveProgramStatusPaneKey(paneKey),
    now: () => Date.now()
  })
  const ingress: ProgramStatusIngress = {
    ...inner,
    fact: (ptyId, fact) => (calls.push(`fact:${fact.reportSeq}`), inner.fact(ptyId, fact)),
    register: (ptyId, snapshot) => (
      calls.push(`register:${snapshot.reportSeq}`),
      inner.register(ptyId, snapshot)
    )
  }
  installProgramStatusIngress(ingress)
  const slot = () =>
    server.getProgramStatusSnapshot().find((row) => row.paneKey === PANE)?.programStatus
  return { server, ops, calls, targets, ingress, slot }
}

async function until(predicate: () => boolean): Promise<void> {
  await vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 3_000, interval: 5 })
}

/** The link drops under main, the way a crashed or restarting daemon looks from here. */
function dropLink(adapter: DaemonPtyAdapter): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the adapter's private client only to drop its control socket.
  const client = (adapter as unknown as { client: { controlSocket: Socket | null } }).client
  client.controlSocket?.destroy()
}

/** Captures the adapter's own event listener, so a late stream event can be replayed through it. */
function captureEventListeners(): ((event: unknown) => void)[] {
  const listeners: ((event: unknown) => void)[] = []
  const onEvent = DaemonClient.prototype.onEvent
  vi.spyOn(DaemonClient.prototype, 'onEvent').mockImplementation(function (
    this: DaemonClient,
    listener
  ) {
    listeners.push(listener)
    return onEvent.call(this, listener)
  })
  return listeners
}

describe('OSC 7501 from a daemon PTY into the store (protocol 50)', () => {
  let harness: DaemonAdapterHarness
  let subprocesses: Subprocess[]
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
    vi.restoreAllMocks()
    installProgramStatusIngress(null)
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    await harness.server.shutdown()
    rmSync(harness.dir, { recursive: true, force: true })
  })

  const emit = (data: string, index = subprocesses.length - 1) =>
    subprocesses[index]!._simulateData(data)
  const spawnArmed = (adapter = harness.adapter) =>
    adapter.spawn({ sessionId: PTY, cols: 80, rows: 24, startupIngress: ARMED })
  const reattach = (adapter = harness.adapter) =>
    adapter.spawn({ sessionId: PTY, cols: 80, rows: 24, attachOnly: true })

  it('lands a report as a live slot of the session incarnation; an unarmed spawn sends nothing', async () => {
    const plain = await harness.adapter.spawn({ sessionId: 'pty-plain', cols: 80, rows: 24 })
    emit(report('state=working'))
    const armed = await spawnArmed()
    emit(report('state=working'))

    await until(() => main.slot()?.shown.summary.aggregate === 'working')
    expect(main.slot()).toMatchObject({
      ptyId: PTY,
      incarnationId: armed.incarnationId,
      reportSeq: 1,
      liveness: 'live',
      view: 'now'
    })
    // The snapshot is consumed by the provider; nothing past it sees the field.
    expect(armed).not.toHaveProperty('programStatus')
    expect(plain).not.toHaveProperty('programStatus')
    expect(main.calls).toEqual(['register:0', 'fact:1'])
  })

  it('holds a fact that overtakes the control reply, and registration adopts it', async () => {
    const request = DaemonClient.prototype.request
    vi.spyOn(DaemonClient.prototype, 'request').mockImplementation(async function (
      this: DaemonClient,
      type: string,
      payload: unknown,
      ...rest: [number?, AbortSignal?]
    ) {
      const reply = await request.call(this, type, payload, ...rest)
      if (type === 'createOrAttach') {
        // The daemon took its snapshot before this report, so this fact outranks it.
        emit(report('state=working'))
        await until(() => main.calls.includes('fact:1'))
      }
      return reply
    })

    await spawnArmed()

    expect(main.calls).toEqual(['fact:1', 'register:0'])
    expect(main.slot()).toMatchObject({ reportSeq: 1, liveness: 'live' })
    expect(main.slot()?.shown.summary.aggregate).toBe('working')
  })

  it('fences a replaced incarnation: its late high fact drops, the new low resync stands', async () => {
    const listeners = captureEventListeners()
    const exited: string[] = []
    harness.adapter.onExit(({ id }) => exited.push(id))
    const first = await spawnArmed()
    emit(report('state=working'))
    emit(report('state=done'))
    await until(() => main.slot()?.reportSeq === 2)
    const oldObservation = { now: main.slot()!.shown, onExit: main.slot()!.shown }

    subprocesses[0]!._simulateExit(0)
    await until(() => exited.includes(PTY))
    const second = await spawnArmed()
    expect(second.incarnationId).not.toBe(first.incarnationId)
    emit(report('state=blocked'))
    await until(() => main.slot()?.shown.summary.aggregate === 'blocked')
    // The new incarnation starts again from 1, below the 2 the old one reached, and is shown.
    expect(main.slot()).toMatchObject({ incarnationId: second.incarnationId, reportSeq: 1 })

    main.ops.length = 0
    for (const listener of listeners) {
      listener({
        type: 'event',
        event: 'transientFact',
        sessionId: PTY,
        payload: {
          kind: 'program-status',
          incarnationId: first.incarnationId,
          reportSeq: 99,
          observation: oldObservation
        }
      })
    }
    expect(main.calls.at(-1)).toBe('fact:99')
    expect(main.ops).toEqual([])
    expect(main.slot()).toMatchObject({ incarnationId: second.incarnationId, reportSeq: 1 })

    // The new incarnation's own resync at its low sequence is an equal no-op, never refused.
    await reattach()
    expect(main.calls.at(-1)).toBe('register:1')
    expect(main.ops).toEqual([])
    expect(main.slot()).toMatchObject({ incarnationId: second.incarnationId, reportSeq: 1 })
  })

  it('shows a silent program again after an app restart that kept the daemon', async () => {
    const armed = await spawnArmed()
    emit(report('state=working'))
    await until(() => main.slot()?.reportSeq === 1)
    const before = main.slot()!
    harness.adapter.dispose()
    installProgramStatusIngress(null)
    await new Promise((resolve) => setTimeout(resolve, 20))

    // A fresh main: empty store, empty ingress. The PTY record is not attributed yet.
    const restarted = installMain({ attributed: false })
    const adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    adapters.push(adapter)
    const restartedAt = Date.now()
    await reattach(adapter)
    // Open question pinned: with no pane to attribute to, the registration publishes nothing.
    expect(restarted.calls).toEqual(['register:1'])
    expect(restarted.slot()).toBeUndefined()

    // The renderer's bind restore attributes it; the program has said nothing since.
    restarted.ingress.resyncPane(PANE, PTY, () => true)
    expect(restarted.slot()).toMatchObject({
      incarnationId: armed.incarnationId,
      reportSeq: 1,
      liveness: 'live'
    })
    // The times are the program's, not the restart's.
    expect(restarted.slot()!.shown).toEqual(before.shown)
    expect(restarted.slot()!.shown.changedAt).toBeLessThan(restartedAt)
  })

  it('reports a state that changed while the app was closed, from the reply snapshot', async () => {
    await spawnArmed()
    emit(report('state=working'))
    await until(() => main.slot()?.reportSeq === 1)
    harness.adapter.dispose()
    emit(report('state=done'))

    const adapter = new DaemonPtyAdapter({
      socketPath: harness.socketPath,
      tokenPath: harness.tokenPath
    })
    adapters.push(adapter)
    main.ops.length = 0
    await reattach(adapter)

    expect(main.ops).toEqual(['report'])
    expect(main.slot()).toMatchObject({ reportSeq: 2, liveness: 'live' })
    expect(main.slot()?.shown.summary.aggregate).toBe('done')
  })

  it('marks a dropped link unverifiable and a reattach live again, generation unchanged', async () => {
    await spawnArmed()
    emit(report('state=done'))
    await until(() => main.slot()?.reportSeq === 1)
    const shown = main.slot()!.shown
    main.ops.length = 0

    dropLink(harness.adapter)
    await until(() => main.slot()?.liveness === 'unverifiable')
    expect(main.slot()!.shown).toEqual(shown)

    await reattach()
    expect(main.ops).toEqual(['lifecycle:unverifiable', 'lifecycle:live'])
    expect(main.slot()).toMatchObject({ reportSeq: 1, liveness: 'live' })
    expect(main.slot()!.shown.generation).toBe(shown.generation)
  })

  it('applies a state that moved during the drop before it goes live again', async () => {
    await spawnArmed()
    emit(report('state=working'))
    await until(() => main.slot()?.reportSeq === 1)
    dropLink(harness.adapter)
    await until(() => main.slot()?.liveness === 'unverifiable')
    // No client is attached: the daemon's fact goes nowhere, the snapshot keeps it.
    emit(report('state=done'))
    main.ops.length = 0

    await reattach()

    expect(main.ops).toEqual(['report', 'lifecycle:live'])
    expect(main.slot()).toMatchObject({ reportSeq: 2, liveness: 'live' })
    expect(main.slot()?.shown.summary.aggregate).toBe('done')
  })
})
