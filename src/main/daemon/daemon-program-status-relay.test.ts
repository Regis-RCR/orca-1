import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import { parseProgramStatusFact } from '../../shared/program-status/program-status-slot'
import type * as StartupIngressModule from '../../shared/pty-startup-ingress'
import { DaemonServer } from './daemon-server'
import type { ConnectedDaemonClient } from './daemon-client-connections'
import type { DaemonStreamDataBatcher } from './daemon-stream-data-batcher'
import type { BackgroundTransientFactRelay } from './daemon-background-transient-facts'
import type { PendingStreamDataBatch } from './daemon-stream-keep-tail-drop'
import type { SubprocessHandle } from './session-subprocess-handle'
import {
  createDaemonProgramStatusRelay,
  type DaemonProgramStatusOutlet
} from './daemon-program-status-relay'
import type { DaemonEvent, DaemonProgramStatusFact, DaemonRequest } from './types'

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

const report = (body: string): string => `\x1b]7501;${body}\x07`
const ARMED: PtyStartupIngressIntent = {
  colors: { foreground: '#000000', background: '#ffffff' },
  deadlineMs: 1_000,
  programStatus: { ingest: true }
}

function recordingOutlet(incarnationId = 'inc-1') {
  const facts: DaemonProgramStatusFact[] = []
  const outlet: DaemonProgramStatusOutlet = { incarnationId, emit: (fact) => facts.push(fact) }
  return { outlet, facts }
}

describe('daemon program-status relay', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('arms only on an intent that asks for ingestion', () => {
    const { outlet } = recordingOutlet()
    const { programStatus: _omitted, ...unarmed } = ARMED
    expect(createDaemonProgramStatusRelay(undefined, outlet)).toBeNull()
    expect(createDaemonProgramStatusRelay(unarmed, outlet)).toBeNull()
    expect(createDaemonProgramStatusRelay(ARMED, outlet)).not.toBeNull()
  })

  it('relays each chunk projection change with the incarnation, its sequence and both views', () => {
    const { outlet, facts } = recordingOutlet()
    const relay = createDaemonProgramStatusRelay(ARMED, outlet, { now: () => 5_000 })!
    relay.observe(`noise ${report('state=working')} more`)
    relay.observe(report('state=done:id=child'))

    expect(facts.map((fact) => [fact.kind, fact.incarnationId, fact.reportSeq])).toEqual([
      ['program-status', 'inc-1', 1],
      ['program-status', 'inc-1', 2]
    ])
    expect(facts[1]!.observation).toEqual({
      now: {
        summary: { aggregate: 'working', root: 'working', childError: false },
        generation: expect.any(Number),
        changedAt: 5_000,
        rootChangedAt: 5_000
      },
      onExit: {
        summary: { aggregate: 'done', root: null, childError: false },
        generation: expect.any(Number),
        changedAt: 5_000,
        rootChangedAt: null
      }
    })
    // The snapshot is the last state, unchanged by reading it.
    expect(relay.snapshot()).toEqual({
      incarnationId: 'inc-1',
      reportSeq: 2,
      observation: facts[1]!.observation
    })
    expect(relay.snapshot()).toEqual(relay.snapshot())
  })

  it('flushes a throttled state once at close, before the exit, then stays silent', () => {
    const { outlet, facts } = recordingOutlet()
    const relay = createDaemonProgramStatusRelay(ARMED, outlet)!
    const states = ['working', 'done', 'working', 'blocked', 'working', 'done', 'idle', 'working']
    for (const state of [...states, 'error', 'done']) {
      relay.observe(report(`state=${state}`))
    }
    // The burst is spent: the last two states wait for the trailing timer.
    expect(facts.map((fact) => fact.reportSeq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])

    relay.close()
    expect(facts.at(-1)).toMatchObject({ reportSeq: 10 })
    expect(facts.at(-1)!.observation.now?.summary.aggregate).toBe('done')
    relay.close()
    relay.observe(report('state=error'))
    vi.advanceTimersByTime(10_000)
    expect(facts).toHaveLength(9)
  })
})

type MockSubprocess = SubprocessHandle & {
  emitData(data: string): void
  emitExit(code: number): void
}

type DaemonPrivate = {
  connections: { clients: Map<string, ConnectedDaemonClient> }
  requestRouter: { route(clientId: string, request: DaemonRequest): Promise<unknown> }
  streamDataBatcher: DaemonStreamDataBatcher
  transientFactRelay: BackgroundTransientFactRelay
  attachments: { detachClientSessions(clientId: string): void }
}

function createMockSubprocess(): MockSubprocess {
  let onData: ((data: string) => void) | undefined
  let onExit: ((code: number) => void) | undefined
  return {
    pid: 55_556,
    getForegroundProcess: () => null,
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(() => onExit?.(0)),
    terminateOwnedTree: () => 'unavailable' as const,
    forceKill: vi.fn(() => onExit?.(137)),
    signal: vi.fn(),
    onData: (callback) => {
      onData = callback
    },
    onExit: (callback) => {
      onExit = callback
    },
    dispose: vi.fn(),
    emitData: (data) => onData?.(data),
    emitExit: (code) => onExit?.(code)
  }
}

describe('daemon server: OSC 7501 facts on the stream', () => {
  let server: DaemonServer | undefined
  let subprocesses: MockSubprocess[]
  let daemon: DaemonPrivate
  let controls: DaemonEvent[]

  beforeEach(() => {
    vi.useFakeTimers()
    subprocesses = []
    const unique = randomUUID()
    server = new DaemonServer({
      socketPath: join(tmpdir(), `orca-program-status-${unique}.sock`),
      tokenPath: join(tmpdir(), `orca-program-status-${unique}.token`),
      spawnSubprocess: () => {
        const subprocess = createMockSubprocess()
        subprocesses.push(subprocess)
        return subprocess
      }
    })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the test reads only the private members DaemonPrivate names.
    daemon = server as unknown as DaemonPrivate
    controls = []
    const enqueue = daemon.streamDataBatcher.enqueueControlEvent.bind(daemon.streamDataBatcher)
    vi.spyOn(daemon.streamDataBatcher, 'enqueueControlEvent').mockImplementation(
      (clientId, sessionId, control) => {
        controls.push(control)
        enqueue(clientId, sessionId, control)
      }
    )
  })

  afterEach(async () => {
    await server?.shutdown()
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  function addClient(writableLength = 0): void {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the batcher reads only destroyed, writableLength, write and destroy.
    const streamSocket = {
      destroyed: false,
      writableLength,
      destroy: vi.fn(),
      write: vi.fn(() => true)
    } as unknown as Socket
    daemon.connections.clients.set('client-1', {
      clientId: 'client-1',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: only destroy() is called on the control socket here.
      controlSocket: { destroy: vi.fn() } as unknown as Socket,
      streamSocket,
      authenticatedPairEstablished: true
    })
  }

  /** The wire reply, read the way main reads it: the snapshot through the strict codec. */
  async function createOrAttach(sessionId: string, startupIngress?: PtyStartupIngressIntent) {
    const reply = await daemon.requestRouter.route('client-1', {
      id: randomUUID(),
      type: 'createOrAttach',
      payload: { sessionId, cols: 80, rows: 24, ...(startupIngress ? { startupIngress } : {}) }
    })
    const fields = typeof reply === 'object' && reply !== null ? reply : {}
    return {
      incarnationId: 'incarnationId' in fields ? String(fields.incarnationId) : '',
      programStatus: 'programStatus' in fields ? parseProgramStatusFact(fields.programStatus) : null
    }
  }

  const facts = () =>
    controls.flatMap((control) =>
      control.event === 'transientFact' && control.payload.kind === 'program-status'
        ? [control.payload]
        : []
    )

  function pendingBatch(): PendingStreamDataBatch {
    type BatcherQueues = { pendingByClient: Map<string, PendingStreamDataBatch> }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: reads the batcher's private per-client queue, nothing else.
    const queues = daemon.streamDataBatcher as unknown as BatcherQueues
    const batch = queues.pendingByClient.get('client-1')
    if (!batch) {
      throw new Error('missing client-1 batch')
    }
    return batch
  }

  it('rides the existing transientFact event, armed sessions only, with the reply snapshot', async () => {
    addClient()
    const plain = await createOrAttach('session-plain')
    const armed = await createOrAttach('session-armed', ARMED)
    expect(plain.programStatus).toBeNull()
    expect(armed.programStatus).toEqual({
      incarnationId: armed.incarnationId,
      reportSeq: 0,
      observation: { now: null, onExit: null }
    })

    subprocesses[0]!.emitData(report('state=working'))
    subprocesses[1]!.emitData(report('state=working'))

    expect(controls.filter((control) => control.event === 'transientFact')).toEqual([
      {
        type: 'event',
        event: 'transientFact',
        sessionId: 'session-armed',
        payload: expect.objectContaining({
          kind: 'program-status',
          incarnationId: armed.incarnationId,
          reportSeq: 1
        })
      }
    ])
  })

  it('tracks before thinning: a backlogged backgrounded session keeps every fact', async () => {
    addClient(128 * 1024)
    daemon.transientFactRelay.setSessionBackground('session-hidden', true)
    await createOrAttach('session-hidden', ARMED)
    const filler = 'x'.repeat(600 * 1024)

    subprocesses[0]!.emitData(report('state=working') + filler)
    subprocesses[0]!.emitData(report('state=blocked:kind=permission') + filler)
    subprocesses[0]!.emitData(`${report('state=done')}tail`)

    const batch = pendingBatch()
    const queuedData = batch.queue.map((entry) => entry.data).join('')
    // The keep-tail dropped the oldest bytes, both earlier reports among them...
    expect(batch.queue.some((entry) => entry.control?.event === 'dataGap')).toBe(true)
    expect(queuedData).not.toContain('state=working')
    expect(queuedData).not.toContain('state=blocked')
    // ...and every transition still reached the stream, in order, as a fact.
    expect(facts().map((fact) => fact.observation.now?.summary.aggregate)).toEqual([
      'working',
      'blocked',
      'done'
    ])
  })

  it('drops facts while no client is attached and the reattach snapshot carries the latest', async () => {
    addClient()
    const first = await createOrAttach('session-kept', ARMED)
    subprocesses[0]!.emitData(report('state=working'))
    daemon.attachments.detachClientSessions('client-1')
    const before = facts().length

    subprocesses[0]!.emitData(report('state=done'))
    expect(facts()).toHaveLength(before)

    const again = await createOrAttach('session-kept')
    expect(again.incarnationId).toBe(first.incarnationId)
    expect(again.programStatus).toMatchObject({ incarnationId: first.incarnationId, reportSeq: 2 })
    expect(again.programStatus?.observation.now?.summary.aggregate).toBe('done')
  })

  it('flushes the throttled final state before the exit event', async () => {
    addClient()
    await createOrAttach('session-exit', ARMED)
    const states = ['working', 'done', 'working', 'blocked', 'working', 'done', 'idle', 'working']
    for (const state of [...states, 'error']) {
      subprocesses[0]!.emitData(report(`state=${state}`))
    }
    expect(facts().at(-1)?.reportSeq).toBe(8)

    subprocesses[0]!.emitExit(0)

    const order = controls.map((control) =>
      control.event === 'transientFact' && control.payload.kind === 'program-status'
        ? `fact:${control.payload.reportSeq}`
        : control.event
    )
    expect(order.slice(-2)).toEqual(['fact:9', 'exit'])
  })
})
