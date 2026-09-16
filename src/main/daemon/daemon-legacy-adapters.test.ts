import type * as FsModule from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDaemonPidPath, getDaemonSocketPath } from './daemon-spawner'
import { createLegacyDaemonAdapters } from './daemon-legacy-adapters'

const {
  probeSocketMock,
  adapterConstructions,
  listSessionsImpls,
  hasChildProcessesImpls,
  pidFileContents
} = vi.hoisted(() => ({
  probeSocketMock: vi.fn(async (_socketPath: string) => false),
  adapterConstructions: [] as { options: Record<string, unknown> }[],
  listSessionsImpls: new Map<number, () => Promise<{ sessionId: string }[]>>(),
  hasChildProcessesImpls: new Map<string, () => Promise<boolean>>(),
  pidFileContents: new Map<string, string>()
}))

vi.mock('./daemon-launch-paths', () => ({
  getDaemonHistoryDir: () => '/fake/history',
  probeDaemonSocket: (socketPath: string) => probeSocketMock(socketPath)
}))

vi.mock('./daemon-pty-adapter', () => ({
  DaemonPtyAdapter: class {
    protocolVersion: number
    listSessions: ReturnType<typeof vi.fn>
    hasChildProcesses: ReturnType<typeof vi.fn>
    constructor(options: Record<string, unknown>) {
      this.protocolVersion = options.protocolVersion as number
      adapterConstructions.push({ options })
      this.listSessions = vi.fn(async () => {
        const impl = listSessionsImpls.get(this.protocolVersion)
        return impl ? impl() : []
      })
      this.hasChildProcesses = vi.fn(async (sessionId: string) => {
        const impl = hasChildProcessesImpls.get(sessionId)
        return impl ? impl() : false
      })
    }
  }
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof FsModule>()
  return {
    ...actual,
    readFileSync: ((path: unknown, _options?: unknown) => {
      const contents = pidFileContents.get(String(path))
      if (contents === undefined) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      }
      return contents
    }) as typeof actual.readFileSync,
    unlinkSync: vi.fn()
  }
})

const RUNTIME_DIR = '/fake/runtime'

function validPidRecord(pid: number): string {
  return JSON.stringify({
    pid,
    startedAtMs: 1_000,
    entryPath: null,
    appVersion: null,
    launchNonce: null,
    linuxStartTicks: null,
    bootId: null,
    spawnerExecPath: null
  })
}

describe('createLegacyDaemonAdapters registry', () => {
  beforeEach(() => {
    probeSocketMock.mockReset().mockResolvedValue(false)
    adapterConstructions.length = 0
    listSessionsImpls.clear()
    hasChildProcessesImpls.clear()
    pidFileContents.clear()
    vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('builds a registry entry with protocol version, pid, socket path, and per-session busy/idle state', async () => {
    const protocolVersion = 9
    const socketPath = getDaemonSocketPath(RUNTIME_DIR, protocolVersion)
    probeSocketMock.mockImplementation(async (path: string) => path === socketPath)
    pidFileContents.set(getDaemonPidPath(RUNTIME_DIR, protocolVersion), validPidRecord(4242))
    listSessionsImpls.set(protocolVersion, async () => [
      { sessionId: 'legacy-idle' },
      { sessionId: 'legacy-busy' }
    ])
    hasChildProcessesImpls.set('legacy-idle', async () => false)
    hasChildProcessesImpls.set('legacy-busy', async () => true)

    const { adapters, registry } = await createLegacyDaemonAdapters(RUNTIME_DIR)

    expect(adapters).toHaveLength(1)
    expect(adapters[0].protocolVersion).toBe(protocolVersion)
    expect(registry).toEqual([
      {
        protocolVersion,
        pid: 4242,
        socketPath,
        sessions: [
          { sessionId: 'legacy-idle', busy: false },
          { sessionId: 'legacy-busy', busy: true }
        ]
      }
    ])
  })

  it('omits both the adapter and the registry entry for a protocol version whose socket is unreachable and whose pid is confirmed dead', async () => {
    const protocolVersion = 9
    pidFileContents.set(getDaemonPidPath(RUNTIME_DIR, protocolVersion), validPidRecord(99_999))

    const { adapters, registry } = await createLegacyDaemonAdapters(RUNTIME_DIR)

    expect(adapters).toEqual([])
    expect(registry).toEqual([])
  })

  it('still returns an adapter and a registry entry with an empty session list when the session inventory RPC fails', async () => {
    const protocolVersion = 9
    const socketPath = getDaemonSocketPath(RUNTIME_DIR, protocolVersion)
    probeSocketMock.mockImplementation(async (path: string) => path === socketPath)
    pidFileContents.set(getDaemonPidPath(RUNTIME_DIR, protocolVersion), validPidRecord(4242))
    listSessionsImpls.set(protocolVersion, async () => {
      throw new Error('legacy daemon unreachable mid-inventory')
    })

    const { adapters, registry } = await createLegacyDaemonAdapters(RUNTIME_DIR)

    expect(adapters).toHaveLength(1)
    expect(registry).toEqual([{ protocolVersion, pid: 4242, socketPath, sessions: [] }])
  })

  it('leaves pid null in the registry entry when the pid record cannot be read for a live generation', async () => {
    const protocolVersion = 9
    const socketPath = getDaemonSocketPath(RUNTIME_DIR, protocolVersion)
    probeSocketMock.mockImplementation(async (path: string) => path === socketPath)
    listSessionsImpls.set(protocolVersion, async () => [])

    const { adapters, registry } = await createLegacyDaemonAdapters(RUNTIME_DIR)

    expect(adapters).toHaveLength(1)
    expect(registry).toEqual([{ protocolVersion, pid: null, socketPath, sessions: [] }])
  })
})
