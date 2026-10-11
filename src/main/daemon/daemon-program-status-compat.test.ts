import './mock-descendant-sweep'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type { ProgramStatusFact } from '../../shared/program-status/program-status-slot'
import { createProgramStatusIngress } from '../program-status/program-status-ingress'
import { installProgramStatusIngress } from '../program-status/program-status-local-ingest'
import { DaemonClient } from './client'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { createMockSubprocess } from './daemon-pty-adapter-test-harness'
import { DaemonPtyRouter } from './daemon-pty-router'
import {
  PREVIOUS_DAEMON_PROTOCOL_VERSIONS,
  PROTOCOL_VERSION,
  supportsProgramStatusFacts
} from './daemon-protocol-version'
import { DaemonServer } from './daemon-server'
import { getDaemonSocketPath } from './daemon-spawner'
import type { DaemonFileLog } from './daemon-file-log'

const ARMED: PtyStartupIngressIntent = {
  colors: { foreground: '#000000', background: '#ffffff' },
  deadlineMs: 1_000,
  programStatus: { ingest: true }
}
const FACT: ProgramStatusFact = {
  incarnationId: 'inc-1',
  reportSeq: 3,
  observation: {
    now: {
      summary: { aggregate: 'working', root: 'working', childError: false },
      generation: 2,
      changedAt: 1_000,
      rootChangedAt: 1_000
    },
    onExit: null
  }
}
const log: DaemonFileLog = { log: () => {}, close: () => {} }

/** Records what reaches the ingress; the store behind it is irrelevant to version gating. */
function installRecordingIngress(): string[] {
  const heard: string[] = []
  const inner = createProgramStatusIngress({
    sink: { report: () => true, lifecycle: () => true, rekey: () => true, forget: () => true },
    resolveTarget: () => undefined,
    resolvePaneKey: (paneKey) => paneKey,
    now: () => 0
  })
  installProgramStatusIngress({
    ...inner,
    fact: (ptyId, fact) => (heard.push(`fact:${ptyId}`), inner.fact(ptyId, fact)),
    register: (ptyId, snapshot) => (
      heard.push(`register:${ptyId}`),
      inner.register(ptyId, snapshot)
    )
  })
  return heard
}

describe('OSC 7501 across daemon protocol versions', () => {
  const servers: DaemonServer[] = []
  const adapters: DaemonPtyAdapter[] = []
  const directories: string[] = []
  let router: DaemonPtyRouter | null = null

  afterEach(async () => {
    vi.restoreAllMocks()
    installProgramStatusIngress(null)
    router?.dispose()
    router = null
    for (const adapter of adapters.splice(0)) {
      adapter.dispose()
    }
    await Promise.all(servers.splice(0).map((server) => server.shutdown()))
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  async function startServer(directory: string, protocolVersion: number) {
    const socketPath = getDaemonSocketPath(directory, protocolVersion)
    const tokenPath = join(directory, `v${protocolVersion}.token`)
    const subprocesses: ReturnType<typeof createMockSubprocess>[] = []
    const server = new DaemonServer({
      socketPath,
      tokenPath,
      protocolVersion,
      log,
      spawnSubprocess: () => {
        const subprocess = createMockSubprocess()
        subprocesses.push(subprocess)
        return subprocess
      }
    })
    servers.push(server)
    await server.start()
    const adapter = (version = protocolVersion) => {
      const created = new DaemonPtyAdapter({ socketPath, tokenPath, protocolVersion: version })
      adapters.push(created)
      return created
    }
    return { socketPath, tokenPath, subprocesses, adapter }
  }

  function tempDirectory(): string {
    const directory = mkdtempSync(join(tmpdir(), 'daemon-program-status-compat-'))
    directories.push(directory)
    return directory
  }

  it('bumps the protocol to 50 and keeps 49 attachable, the facts gated at 50', () => {
    expect(PROTOCOL_VERSION).toBe(50)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).toContain(49)
    expect(PREVIOUS_DAEMON_PROTOCOL_VERSIONS).not.toContain(50)
    expect(supportsProgramStatusFacts(49)).toBe(false)
    expect(supportsProgramStatusFacts(50)).toBe(true)
  })

  it('adopts a v49 session that survived the update and keeps it hook-only', async () => {
    const directory = tempDirectory()
    const legacy = await startServer(directory, 49)
    const current = await startServer(directory, 50)
    const original = await legacy.adapter().spawn({
      sessionId: 'v49-pane',
      cols: 80,
      rows: 24,
      startupIngress: ARMED
    })
    legacy.subprocesses[0]!._simulateData('\x1b]7501;state=working\x07')
    const heard = installRecordingIngress()
    router = new DaemonPtyRouter({ current: current.adapter(), legacy: [legacy.adapter()] })
    await router.discoverLegacySessions()

    const adopted = await router.spawn({
      sessionId: original.id,
      cols: 80,
      rows: 24,
      attachOnly: true
    })
    legacy.subprocesses[0]!._simulateData('\x1b]7501;state=done\x07')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(adopted).toMatchObject({ id: original.id, incarnationId: original.incarnationId })
    expect(legacy.subprocesses).toHaveLength(1)
    expect(current.subprocesses).toHaveLength(0)
    expect(heard).toEqual([])
  })

  it('drops a program-status fact from a daemon below 50 and ingests it from 50', async () => {
    const directory = tempDirectory()
    const { adapter } = await startServer(directory, 50)
    const listeners = new Map<DaemonPtyAdapter, (event: unknown) => void>()
    vi.spyOn(DaemonClient.prototype, 'onEvent').mockImplementation(() => () => {})
    const route = (target: DaemonPtyAdapter) => {
      const spy = vi.mocked(DaemonClient.prototype.onEvent)
      spy.mockImplementationOnce((listener) => (listeners.set(target, listener), () => {}))
      target['removeEventListener'] = null
      target['setupEventRouting']()
    }
    const old = adapter(49)
    const fresh = adapter(50)
    route(old)
    route(fresh)
    const forwarded: string[] = []
    for (const target of [old, fresh]) {
      target.onBackgroundStreamEvent((payload) => forwarded.push(payload.kind))
    }
    const heard = installRecordingIngress()
    const event = (sessionId: string) => ({
      type: 'event',
      event: 'transientFact',
      sessionId,
      payload: { kind: 'program-status', ...FACT }
    })

    listeners.get(old)!(event('pty-old'))
    listeners.get(fresh)!(event('pty-new'))
    // A malformed fact never reaches the ingress, whatever the version.
    listeners.get(fresh)!({ ...event('pty-bad'), payload: { kind: 'program-status' } })

    expect(heard).toEqual(['fact:pty-new'])
    // Never handed on as a runtime transient fact, whichever version sent it.
    expect(forwarded).toEqual([])
  })

  it('reads a reply snapshot from a daemon at 50 only', async () => {
    const directory = tempDirectory()
    const legacy = await startServer(directory, 49)
    const current = await startServer(directory, 50)
    const request = DaemonClient.prototype.request
    // Why forged: a real v49 daemon cannot send the field, so a v49 reply carrying it is the
    // only way to prove main would not read one.
    vi.spyOn(DaemonClient.prototype, 'request').mockImplementation(async function (
      this: DaemonClient,
      type: string,
      payload: unknown,
      ...rest: [number?, AbortSignal?]
    ) {
      const reply = await request.call(this, type, payload, ...rest)
      return type === 'createOrAttach' && reply && typeof reply === 'object'
        ? { ...reply, programStatus: FACT }
        : reply
    })
    const heard = installRecordingIngress()

    const old = await legacy.adapter().spawn({ sessionId: 'pty-old', cols: 80, rows: 24 })
    const fresh = await current.adapter().spawn({ sessionId: 'pty-new', cols: 80, rows: 24 })

    expect(heard).toEqual(['register:pty-new'])
    expect(old).not.toHaveProperty('programStatus')
    expect(fresh).not.toHaveProperty('programStatus')
  })

  it('an app downgraded below 50 does not discover a v50 daemon', async () => {
    const directory = tempDirectory()
    const current = await startServer(directory, 50)
    expect(current.socketPath).not.toBe(getDaemonSocketPath(directory, 49))
    // Even pointed at the v50 endpoint, a v49 client is refused at hello.
    const downgraded = new DaemonClient({
      socketPath: current.socketPath,
      tokenPath: current.tokenPath,
      protocolVersion: 49
    })
    await expect(downgraded.ensureConnected()).rejects.toThrow(/version/i)
    downgraded.disconnect()
  })

  it('keeps the field off the wire in this commit, so a v50 daemon never arms (dormant)', async () => {
    expect(parsePtyStartupIngressIntent(ARMED)).not.toHaveProperty('programStatus')
    const directory = tempDirectory()
    const current = await startServer(directory, 50)
    const heard = installRecordingIngress()
    const spawned = await current.adapter().spawn({
      sessionId: 'pty-dormant',
      cols: 80,
      rows: 24,
      startupIngress: ARMED
    })
    current.subprocesses[0]!._simulateData('\x1b]7501;state=working\x07')
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(spawned).not.toHaveProperty('programStatus')
    expect(heard).toEqual([])
  })
})
