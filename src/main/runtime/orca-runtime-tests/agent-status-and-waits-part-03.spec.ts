import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime-test-mocks.spec'
import { TEST_WORKTREE_ID, store } from '../orca-runtime-test-fixtures.spec'
import { createProgramStatusIngress } from '../../program-status/program-status-ingress'
import {
  installedProgramStatusIngress,
  installProgramStatusIngress
} from '../../program-status/program-status-local-ingest'

afterEach(() => installProgramStatusIngress(null))

// Why a subclass: the prune of one record is protected; the bounded sweep reaches it the same way.
class PruningRuntime extends OrcaRuntimeService {
  pruneRecord(ptyId: string): void {
    this.dropDisconnectedPtyRecord(ptyId)
  }
}

describe('OrcaRuntimeService', () => {
  it('reports recognized foreground agents with unknown status as running with null status', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'repo terminal',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: null
    })
  })

  it('keeps ordinary terminal send suffix failures on the existing not-writable contract', async () => {
    const writes: string[] = []
    const beforeWrite = vi.fn()
    const afterWrite = vi.fn()
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: (_ptyId: string, data: string) => {
        writes.push(data)
        return data !== '\r'
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'Codex ready',
          activeLeafId: 'pane:1',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId: 'pane:1',
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    const [terminal] = (await runtime.listTerminals()).terminals

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldClearNativeTimers: true })
    try {
      await Promise.all([
        expect(
          runtime.sendTerminal(
            terminal.handle,
            { text: 'notes', enter: true },
            { inputKind: 'driving', beforeWrite, afterWrite }
          )
        ).rejects.toThrow('terminal_not_writable'),
        vi.runAllTimersAsync()
      ])
      expect(writes).toEqual(['notes', '\r'])
      expect(beforeWrite).toHaveBeenCalledTimes(2)
      expect(afterWrite).toHaveBeenCalledOnce()
    } finally {
      vi.clearAllTimers()
      vi.useRealTimers()
    }
  })

  it('feeds a tracked local PTY to the OSC 7501 ingest, attributed like OSC 9999, until prune', async () => {
    const runtime = new PruningRuntime(store)
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 't',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        { tabId: 'tab-1', worktreeId: TEST_WORKTREE_ID, leafId, paneRuntimeId: 1, ptyId: 'pty-1' }
      ]
    })
    const writes: unknown[][] = []
    const record = (...entry: unknown[]): boolean => (writes.push(entry), true)
    installProgramStatusIngress(
      createProgramStatusIngress({
        sink: {
          report: (target, write) =>
            record('report', target.paneKey, write.shown?.summary.aggregate),
          lifecycle: (paneKey, write) => record('lifecycle', paneKey, write.liveness),
          rekey: (from) => record('rekey', from),
          forget: (paneKey, _identity, options) => record('forget', paneKey, options)
        },
        resolveTarget: (ptyId) => runtime.resolveProgramStatusPaneTarget(ptyId),
        resolvePaneKey: (paneKey) => paneKey,
        now: () => 5
      })
    )
    const report = '\x1b]7501;state=done\x07'
    runtime.onPtyData('pty-untracked', report, 10)
    expect(writes).toEqual([])
    installedProgramStatusIngress()!.local.begin('pty-1', 'inc-1')
    runtime.onPtyData('pty-1', report, 10)
    expect(writes).toContainEqual(['report', `tab-1:${leafId}`, 'done'])
    runtime.onPtyExit('pty-1', 0)
    expect(writes.at(-1)).toEqual(['lifecycle', `tab-1:${leafId}`, 'exited'])
    runtime.pruneRecord('pty-1')
    expect(writes.at(-1)).toEqual(['forget', `tab-1:${leafId}`, { ptyRetired: true }])
  })
})
