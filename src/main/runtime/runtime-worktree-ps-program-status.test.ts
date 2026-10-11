import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime-test-mocks.spec'
import './orca-runtime-test-lifecycle.spec'
import { TEST_WORKTREE_ID, store } from './orca-runtime-test-fixtures.spec'
import { makeAgentStatusStoreWiring } from './agent-status-store-wiring.test-fixture'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from './runtime-worktree-status-projection'
import { WORKTREE_CATALOG_METHODS } from './rpc/methods/worktree-catalog-methods'
import { WorktreePsParams } from '../../shared/rpc-contract/worktree-params'
import { PROGRAM_STATUS_ENTRY_TABLE } from '../../shared/program-status/program-status-entry-table.test-support'
import type {
  ProgramStatusLiveness,
  ProgramStatusReportWrite,
  ProgramStatusSummaryState
} from '../../shared/program-status/program-status-slot'

/**
 * `orca worktree ps` composes the program-status slot with the hook row only for a caller that
 * asks; every other caller, mobile included, keeps the byte-exact hook-only listing.
 */
const LEAF_ID = '99999999-9999-4999-8999-999999999999'
const PANE_KEY = `tab-ps:${LEAF_ID}`
const NOW = 1_800_000_000_000

function wiredRuntime() {
  const statusWiring = makeAgentStatusStoreWiring()
  const runtime = new OrcaRuntimeService(store, undefined, {
    ...statusWiring.deps,
    getProgramStatusSnapshot: () => statusWiring.statusStore.getProgramStatusSnapshot()
  })
  runtime.attachWindow(1)
  runtime.syncWindowGraph(1, {
    tabs: [
      {
        tabId: 'tab-ps',
        worktreeId: TEST_WORKTREE_ID,
        title: 'Pi',
        activeLeafId: LEAF_ID,
        layout: null
      }
    ],
    leaves: [
      {
        tabId: 'tab-ps',
        worktreeId: TEST_WORKTREE_ID,
        leafId: LEAF_ID,
        paneRuntimeId: 1,
        ptyId: 'ps-pty'
      }
    ]
  })
  return { runtime, statusStore: statusWiring.statusStore }
}

function report(
  aggregate: ProgramStatusSummaryState,
  root: ProgramStatusSummaryState | null = aggregate,
  liveness: ProgramStatusLiveness = 'live',
  reportSeq = 1
): ProgramStatusReportWrite {
  return {
    kind: 'report',
    identity: { ptyId: 'ps-pty', incarnationId: 'inc-ps' },
    reportSeq,
    liveness,
    livenessChangedAt: NOW - 500,
    shown: {
      summary: { aggregate, root, childError: false },
      generation: reportSeq,
      changedAt: NOW - 1_000,
      rootChangedAt: root === null ? null : NOW - 1_100
    }
  }
}

function emitHookWorking(runtime: OrcaRuntimeService): void {
  runtime.onPtyData(
    'ps-pty',
    '\x1b]9999;{"state":"working","prompt":"ship it","agentType":"codex"}\x07',
    1
  )
}

async function agentsOf(runtime: OrcaRuntimeService, compose: boolean) {
  const { worktrees } = await runtime.getWorktreePs(undefined, true, compose)
  return worktrees.find((worktree) => worktree.worktreeId === TEST_WORKTREE_ID)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('worktree ps composes program status only when asked', () => {
  it('a slot-only pane is listed for an opted-in caller and for nobody else', async () => {
    const { runtime, statusStore } = wiredRuntime()
    emitHookWorking(runtime)
    statusStore.dropStatusEntry(PANE_KEY)
    statusStore.ingestProgramStatusReport({
      paneKey: PANE_KEY,
      tabId: 'tab-ps',
      worktreeId: TEST_WORKTREE_ID,
      write: report('blocked')
    })
    expect((await agentsOf(runtime, false))?.agents).toEqual([])
    const composed = await agentsOf(runtime, true)
    expect(composed?.agents).toEqual([
      expect.objectContaining({
        paneKey: PANE_KEY,
        state: 'blocked',
        agentType: null,
        prompt: '',
        toolName: null,
        toolInput: null,
        lastAssistantMessage: null
      })
    ])
    expect(composed?.status).toBe('permission')
  })

  it('hooks-first lists the hook row; the host setting lets the slot win', async () => {
    const { runtime, statusStore } = wiredRuntime()
    emitHookWorking(runtime)
    statusStore.ingestProgramStatusReport({
      paneKey: PANE_KEY,
      tabId: 'tab-ps',
      worktreeId: TEST_WORKTREE_ID,
      write: report('done')
    })
    expect((await agentsOf(runtime, true))?.agents).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, state: 'working', agentType: 'codex' })
    ])
    const settings = store.getSettings()
    vi.spyOn(store, 'getSettings').mockReturnValue(
      Object.assign({}, settings, { agentProgramStatusPreferred: true })
    )
    expect((await agentsOf(runtime, true))?.agents).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, state: 'done', agentType: null })
    ])
    expect((await agentsOf(runtime, false))?.agents).toEqual([
      expect.objectContaining({ paneKey: PANE_KEY, state: 'working', agentType: 'codex' })
    ])
  })

  it('a dismissed slot is not listed, even when asked', async () => {
    const { runtime, statusStore } = wiredRuntime()
    emitHookWorking(runtime)
    statusStore.dropStatusEntry(PANE_KEY)
    statusStore.ingestProgramStatusReport({
      paneKey: PANE_KEY,
      tabId: 'tab-ps',
      worktreeId: TEST_WORKTREE_ID,
      write: report('done')
    })
    statusStore.acknowledgeProgramStatus(PANE_KEY, {
      incarnationId: 'inc-ps',
      view: 'now',
      generation: 1
    })
    expect((await agentsOf(runtime, true))?.agents).toEqual([])
  })

  it.each(PROGRAM_STATUS_ENTRY_TABLE)(
    'aggregate $aggregate with root $root maps like a hook row of the same state and verdict',
    async (row) => {
      const { runtime, statusStore } = wiredRuntime()
      emitHookWorking(runtime)
      statusStore.dropStatusEntry(PANE_KEY)
      statusStore.ingestProgramStatusReport({
        paneKey: PANE_KEY,
        tabId: 'tab-ps',
        worktreeId: TEST_WORKTREE_ID,
        write: report(row.aggregate, row.root)
      })
      const [agent] = (await agentsOf(runtime, true))?.agents ?? []
      expect(agent?.state).toBe(row.state)
      expect(agent?.mainAgent?.outcome ?? null).toBe(row.outcome)
      expect(agent && mapExplicitAgentStateToRuntimeTerminalStatus(agent.state)).toBe(
        row.worktreePs
      )
    }
  )

  it('an idle summary lists as idle on the host too', async () => {
    const { runtime, statusStore } = wiredRuntime()
    emitHookWorking(runtime)
    statusStore.dropStatusEntry(PANE_KEY)
    statusStore.ingestProgramStatusReport({
      paneKey: PANE_KEY,
      tabId: 'tab-ps',
      worktreeId: TEST_WORKTREE_ID,
      write: report('idle', null)
    })
    const [agent] = (await agentsOf(runtime, true))?.agents ?? []
    expect(agent && mapExplicitAgentStateToRuntimeTerminalStatus(agent.state)).toBe('idle')
  })
})

describe('a silent slot on the host past the staleness window', () => {
  async function silentBlockedAfter31Minutes(liveness: ProgramStatusLiveness) {
    vi.spyOn(Date, 'now').mockReturnValue(NOW + 31 * 60_000)
    const { runtime, statusStore } = wiredRuntime()
    emitHookWorking(runtime)
    statusStore.dropStatusEntry(PANE_KEY)
    statusStore.ingestProgramStatusReport({
      paneKey: PANE_KEY,
      tabId: 'tab-ps',
      worktreeId: TEST_WORKTREE_ID,
      write: report('blocked', 'blocked', liveness)
    })
    return agentsOf(runtime, true)
  }

  it('keeps a live slot in the summary without restamping it or widening the row', async () => {
    const summary = await silentBlockedAfter31Minutes('live')
    expect(summary?.status).toBe('permission')
    expect(summary?.hasHostSidebarActivity).toBe(true)
    const [agent] = summary?.agents ?? []
    expect(agent).toMatchObject({ state: 'blocked', updatedAt: NOW - 1_000 })
    expect(agent).not.toHaveProperty('programStatusLive')
  })

  it.each(['unverifiable', 'exited'] as const)(
    'lets a %s slot decay like a silent hook row',
    async (liveness) => {
      expect((await silentBlockedAfter31Minutes(liveness))?.status).not.toBe('permission')
    }
  )
})

describe('the opt-in crosses the RPC as one optional literal', () => {
  it('the params accept the literal and drop nothing a legacy caller sends', () => {
    expect(WorktreePsParams.parse({ composeProgramStatus: true })).toEqual({
      composeProgramStatus: true
    })
    expect(WorktreePsParams.parse({ limit: 5 })).toEqual({ limit: 5 })
    expect(WorktreePsParams.safeParse({ composeProgramStatus: false }).success).toBe(false)
  })

  it('the handler forwards the opt-in, and only when it was sent', async () => {
    const method = WORKTREE_CATALOG_METHODS.find((entry) => entry.name === 'worktree.ps')
    const getWorktreePs = vi.fn(async () => ({ worktrees: [], totalCount: 0, truncated: false }))
    const context = { runtime: { getWorktreePs }, clientCapabilities: undefined }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reads only `runtime.getWorktreePs` and `clientCapabilities` on this path.
    const rpcContext = context as unknown as Parameters<NonNullable<typeof method>['handler']>[1]
    await method?.handler(WorktreePsParams.parse({}), rpcContext)
    await method?.handler(WorktreePsParams.parse({ composeProgramStatus: true }), rpcContext)
    expect(getWorktreePs).toHaveBeenNthCalledWith(1, undefined, true, false)
    expect(getWorktreePs).toHaveBeenNthCalledWith(2, undefined, true, true)
  })
})
