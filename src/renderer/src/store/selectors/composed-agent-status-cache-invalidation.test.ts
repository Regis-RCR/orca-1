// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderHook, type RenderHookResult } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import type { DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'
import type { ProgramStatusPaneIpcPayload } from '../../../../shared/program-status/program-status-pane-payload'
import type {
  ProgramStatusLiveness,
  ProgramStatusSlot,
  ProgramStatusSummaryState
} from '../../../../shared/program-status/program-status-slot'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createTestStore } from '../slices/store-test-helpers'

type TestStore = ReturnType<typeof createTestStore>
const holder: { store?: TestStore } = vi.hoisted(() => ({}))

vi.mock('@/store', () => {
  const current = (): TestStore => {
    if (!holder.store) {
      throw new Error('no test store installed')
    }
    return holder.store
  }
  const useAppStore = <T>(selector: (state: AppState) => T): T => current()(selector)
  return {
    useAppStore: Object.assign(useAppStore, {
      getState: () => current().getState(),
      subscribe: (listener: (state: AppState, previous: AppState) => void) =>
        current().subscribe(listener)
    })
  }
})

import { getLiveEntriesFullRebuildCountForTests } from '../../components/sidebar/worktree-agent-live-index-patch'
import { selectLiveAgentStatusEntriesForWorktree } from '../../components/sidebar/worktree-agent-row-selectors'
import {
  selectWorktreeAgentActivitySummary,
  type AgentActivityInput
} from '../../components/sidebar/worktree-agent-activity-summary'
import { createWorktreeAgentFreshnessSelector } from '../../components/sidebar/worktree-agent-freshness-selector'
import type { selectWorktreeActivityStatuses } from '../../components/sidebar/use-worktree-activity-statuses'
import {
  useAgentBucketCounts,
  resetAgentBucketCountStateForTests,
  type AgentBucketCountState
} from '../../components/dashboard/useAgentBucketCounts'
import type { WorktreeAgentRowsState } from '../../components/dashboard/worktree-agent-rows-cache'
import { useDashboardPopoutBridge } from '../../components/dashboard/useDashboardPopoutBridge'
import { useDashboardSnapshot } from '../../components/dashboard-popout/useDashboardSnapshot'
import { selectTerminalTabActivityStatus } from '../../components/tab-bar/terminal-tab-activity-status'
import {
  canSkipRuntimeMobileSessionSyncKeyBuild,
  getRuntimeMobileSessionSyncKey,
  runtimeMobileSessionSyncKeysEqual
} from '../../runtime/sync-runtime-graph/sync-key'
import {
  agentStatusCompositionToken,
  selectComposedAgentStatusByPaneKey
} from './composed-agent-status'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PANE = makePaneKey('tab1', LEAF)
const T0 = 1_800_000_000_000
const MINUTE = 60_000
const WT = 'w1'

function slot(
  aggregate: ProgramStatusSummaryState,
  liveness: ProgramStatusLiveness = 'live',
  times = { changedAt: T0 - 1_000, livenessChangedAt: T0 - 1_000 }
): ProgramStatusSlot {
  return {
    ptyId: 'pty1',
    incarnationId: 'inc-1',
    reportSeq: 1,
    liveness,
    livenessChangedAt: times.livenessChangedAt,
    view: liveness === 'exited' ? 'onExit' : 'now',
    shown: {
      summary: { aggregate, root: aggregate, childError: false },
      generation: 3,
      changedAt: times.changedAt,
      rootChangedAt: times.changedAt
    }
  }
}

let revision = 0
function slotRow(programStatus: ProgramStatusSlot | null): ProgramStatusPaneIpcPayload {
  revision += 1
  return {
    programStatusOnly: true,
    paneKey: PANE,
    tabId: 'tab1',
    worktreeId: WT,
    revision,
    programStatus
  }
}

function worktree(): Worktree {
  return {
    id: WT,
    repoId: 'r1',
    path: '/r1/w1',
    head: 'abc',
    branch: 'main',
    isBare: false,
    isMainWorktree: false,
    displayName: 'wt',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: T0
  }
}

const TAB: TerminalTab = {
  id: 'tab1',
  ptyId: 'pty1',
  worktreeId: WT,
  title: 'agent',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: T0
}

function installStore(): TestStore {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo', badgeColor: '#000', addedAt: T0 }],
    worktreesByRepo: { r1: [worktree()] },
    tabsByWorktree: { [WT]: [TAB] },
    terminalLayoutsByTabId: {
      tab1: {
        root: { type: 'leaf', leafId: LEAF },
        activeLeafId: LEAF,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF]: 'pty1' }
      }
    },
    ptyIdsByTabId: { tab1: ['pty1'] }
  })
  holder.store = store
  return store
}

function hook(store: TestStore, state: 'working' | 'blocked' | 'done'): void {
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state, prompt: 'hook turn', agentType: 'claude' },
      undefined,
      { updatedAt: Date.now(), stateStartedAt: Date.now() },
      { tabId: 'tab1', worktreeId: WT }
    )
}

const dashboardApi = {
  publishSnapshot: vi.fn(async (_snapshot: DashboardSnapshot) => undefined),
  requestSnapshot: vi.fn(async () => undefined)
}
let popoutListener: ((snapshot: DashboardSnapshot) => void) | null = null
let bridgeRequestListener: (() => void) | null = null

function installWindowApi(): void {
  Object.assign(window, {
    api: {
      agentStatus: {
        drop: vi.fn(),
        retirePaneAuthority: vi.fn(),
        restorePaneAuthority: vi.fn(),
        onSet: () => () => {},
        onClear: () => () => {}
      },
      dashboard: {
        onRevealAgent: () => () => {},
        onPopoutOpenChanged: () => () => {},
        onSnapshotRequested: (listener: () => void) => {
          bridgeRequestListener = listener
          return () => {}
        },
        getPopoutOpen: async () => true,
        publishSnapshot: (snapshot: DashboardSnapshot) => {
          void dashboardApi.publishSnapshot(snapshot)
          popoutListener?.(snapshot)
          return Promise.resolve()
        },
        onSnapshot: (listener: (snapshot: DashboardSnapshot) => void) => {
          popoutListener = listener
          return () => {}
        },
        requestSnapshot: () => {
          void dashboardApi.requestSnapshot()
          bridgeRequestListener?.()
          return Promise.resolve()
        }
      },
      gh: { enqueuePRRefresh: vi.fn(async () => undefined) }
    }
  })
}

function Bridge(): null {
  useDashboardPopoutBridge(true)
  return null
}

type ReaderId = 'r3' | 'r5' | 'r7' | 'r10' | 'r11' | 'r12'
type Views = Record<ReaderId, string>

/** One mounted instance of every cached reader the composition path runs through. */
async function mountReaders(store: TestStore) {
  const readNow = vi.fn(() => Date.now())
  const freshness = createWorktreeAgentFreshnessSelector(WT, readNow)
  const buckets: RenderHookResult<ReturnType<typeof useAgentBucketCounts>, unknown> = renderHook(
    () => useAgentBucketCounts()
  )
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  await act(async () => root.render(createElement(Bridge)))
  await act(async () => {})
  const lastCard = () =>
    dashboardApi.publishSnapshot.mock.calls.at(-1)?.[0].cards.find((card) => card.paneKey === PANE)
  const read = (): Views => {
    const state = store.getState()
    const entry = selectLiveAgentStatusEntriesForWorktree(state, WT).find((e) => e.paneKey === PANE)
    const summary = selectWorktreeAgentActivitySummary(state, WT)
    const signature = freshness(state)
    const counts = Object.entries(buckets.result.current)
      .filter(([, count]) => count > 0)
      .map(([bucket, count]) => `${bucket}:${count}`)
      .join(',')
    return {
      r3: entry ? `${entry.state}@${entry.evidenceObservedAt ?? entry.updatedAt}` : 'none',
      r5: summary.stalePaneIdsByTabId.tab1?.has(LEAF)
        ? 'stale'
        : summary.hasPermission
          ? 'permission'
          : summary.hasLiveWorking
            ? 'working'
            : summary.hasLiveDone
              ? 'done'
              : 'none',
      r7: signature === '' ? 'none' : signature.endsWith('1\0') ? 'fresh' : 'stale',
      r10: counts || 'none',
      r11: lastCard()?.dotState ?? 'none',
      r12: selectTerminalTabActivityStatus(state, TAB)
    }
  }
  const flushPublish = async () => {
    await act(async () => vi.advanceTimersByTime(300))
  }
  return {
    readNow,
    read,
    flushPublish,
    lastCard,
    unmount: async () => {
      buckets.unmount()
      await act(async () => root.unmount())
    }
  }
}

/** Two reads: the second must be a cache hit on every reader that can report one. */
function expectWarm(store: TestStore, readers: Awaited<ReturnType<typeof mountReaders>>): Views {
  const state = store.getState()
  const first = readers.read()
  const rebuilds = getLiveEntriesFullRebuildCountForTests()
  const readNowCalls = readers.readNow.mock.calls.length
  const entries = selectLiveAgentStatusEntriesForWorktree(state, WT)
  const summary = selectWorktreeAgentActivitySummary(state, WT)
  expect(readers.read()).toEqual(first)
  expect(selectLiveAgentStatusEntriesForWorktree(state, WT)).toBe(entries)
  expect(selectWorktreeAgentActivitySummary(state, WT)).toBe(summary)
  expect(getLiveEntriesFullRebuildCountForTests()).toBe(rebuilds)
  expect(readers.readNow.mock.calls.length).toBe(readNowCalls)
  return first
}

/** A slot-only change: nothing on the hook side or the topology moves. */
function expectSlotOnly(store: TestStore, change: () => void): void {
  const before = store.getState()
  act(() => change())
  const after = store.getState()
  expect(after.agentStatusByPaneKey).toBe(before.agentStatusByPaneKey)
  expect(after.tabsByWorktree).toBe(before.tabsByWorktree)
  expect(after.agentStatusEpoch).toBe(before.agentStatusEpoch)
}

async function advanceTo(time: number): Promise<void> {
  await act(async () => vi.advanceTimersByTime(time - Date.now()))
}

const NONE: Views = { r3: 'none', r5: 'none', r7: 'none', r10: 'none', r11: 'none', r12: 'active' }

let store: TestStore
let readers: Awaited<ReturnType<typeof mountReaders>>

beforeEach(async () => {
  vi.useFakeTimers()
  vi.setSystemTime(T0)
  vi.clearAllMocks()
  popoutListener = null
  bridgeRequestListener = null
  resetAgentBucketCountStateForTests()
  installWindowApi()
  store = installStore()
  readers = await mountReaders(store)
})

afterEach(async () => {
  await readers.unmount()
  vi.useRealTimers()
})

describe('every cached reader on the composition path follows a slot-only change', () => {
  it('case 1: a new working slot on a pane with no hook row', async () => {
    expect(expectWarm(store, readers)).toEqual(NONE)
    expectSlotOnly(store, () =>
      store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))])
    )
    await readers.flushPublish()
    expect(readers.read()).toEqual({
      r3: `working@${T0 - 1_000}`,
      r5: 'working',
      r7: 'fresh',
      r10: 'working:1',
      r11: 'working',
      r12: 'working'
    })
  })

  it('case 2: the preference flipped with both producers present', async () => {
    hook(store, 'blocked')
    act(() => store.getState().applyProgramStatusPaneRows([slotRow(slot('done'))]))
    await readers.flushPublish()
    expect(expectWarm(store, readers)).toEqual({
      r3: `blocked@${T0}`,
      r5: 'permission',
      r7: 'fresh',
      r10: 'attention:1',
      r11: 'blocked',
      r12: 'permission'
    })
    expectSlotOnly(store, () => store.getState().setProgramStatusPreferred(true))
    await readers.flushPublish()
    expect(readers.read()).toEqual({
      r3: `done@${T0 - 1_000}`,
      r5: 'done',
      r7: 'none',
      r10: 'done:1',
      r11: 'done',
      r12: 'done'
    })
  })

  it('case 3: a dismissal, first its local hide, then the tombstone of main', async () => {
    act(() => store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))]))
    await readers.flushPublish()
    expect(expectWarm(store, readers).r5).toBe('working')
    expectSlotOnly(store, () => store.getState().acknowledgeProgramStatusForPane(PANE))
    await readers.flushPublish()
    expect(readers.read()).toEqual(NONE)
    expectWarm(store, readers)
    expectSlotOnly(store, () => store.getState().applyProgramStatusPaneRows([slotRow(null)]))
    await readers.flushPublish()
    expect(readers.read()).toEqual(NONE)
  })

  it('case 4: live to unverifiable, then only the slot scheduler crosses the deadline', async () => {
    act(() => store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))]))
    await readers.flushPublish()
    expectWarm(store, readers)
    const unverifiable = slot('working', 'unverifiable', {
      changedAt: T0 - 1_000,
      livenessChangedAt: T0
    })
    expectSlotOnly(store, () =>
      store.getState().applyProgramStatusPaneRows([slotRow(unverifiable)])
    )
    await readers.flushPublish()
    expect(expectWarm(store, readers)).toEqual({
      r3: `working@${T0}`,
      r5: 'working',
      r7: 'fresh',
      r10: 'working:1',
      r11: 'working',
      r12: 'working'
    })
    const epoch = store.getState().programStatusEpoch
    const agentEpoch = store.getState().agentStatusEpoch
    await advanceTo(T0 + AGENT_STATUS_STALE_AFTER_MS)
    expect(store.getState().programStatusEpoch).toBe(epoch)
    await advanceTo(T0 + AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(store.getState().programStatusEpoch).toBe(epoch + 1)
    expect(store.getState().agentStatusEpoch).toBe(agentEpoch)
    await readers.flushPublish()
    expect(readers.read()).toEqual({
      r3: `working@${T0}`,
      r5: 'stale',
      r7: 'stale',
      r10: 'idle:1',
      r11: 'idle',
      r12: 'active'
    })
    await act(async () => vi.advanceTimersByTime(60 * MINUTE))
    expect(store.getState().programStatusEpoch).toBe(epoch + 1)
  })

  it('case 5: a closure deletes a visible record', async () => {
    act(() => store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))]))
    await readers.flushPublish()
    expect(expectWarm(store, readers).r12).toBe('working')
    expectSlotOnly(store, () => store.getState().retireAgentPaneAuthority(PANE))
    expect(store.getState().programStatusByPaneKey[PANE]).toBeUndefined()
    await readers.flushPublish()
    expect(readers.read()).toEqual(NONE)
  })

  // Case 6: the slot scheduler's candidates do not depend on who wins the pane.
  async function losingSlotThenSwitch(switchToSlot: () => void): Promise<void> {
    const unverifiable = slot('working', 'unverifiable', {
      changedAt: T0 - 1_000,
      livenessChangedAt: T0
    })
    act(() => store.getState().applyProgramStatusPaneRows([slotRow(unverifiable)]))
    await act(async () => vi.advanceTimersByTime(MINUTE))
    hook(store, 'working')
    await readers.flushPublish()
    expect(expectWarm(store, readers).r3).toBe(`working@${T0 + MINUTE}`)
    await act(async () => vi.advanceTimersByTime(9 * MINUTE))
    const mirror = store.getState().programStatusByPaneKey
    act(() => switchToSlot())
    expect(store.getState().programStatusByPaneKey).toBe(mirror)
    await readers.flushPublish()
    expect(readers.read()).toMatchObject({ r3: `working@${T0}`, r5: 'working', r7: 'fresh' })
    const epoch = store.getState().programStatusEpoch
    await advanceTo(T0 + AGENT_STATUS_STALE_AFTER_MS)
    expect(store.getState().programStatusEpoch).toBe(epoch)
    await advanceTo(T0 + AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(store.getState().programStatusEpoch).toBe(epoch + 1)
    await readers.flushPublish()
    expect(readers.read()).toEqual({
      r3: `working@${T0}`,
      r5: 'stale',
      r7: 'stale',
      r10: 'idle:1',
      r11: 'idle',
      r12: 'active'
    })
    await act(async () => vi.advanceTimersByTime(60 * MINUTE))
    expect(store.getState().programStatusEpoch).toBe(epoch + 1)
  }

  it('case 6: a losing unverifiable slot, then the preference flipped with no mirror write', async () => {
    await losingSlotThenSwitch(() => store.getState().setProgramStatusPreferred(true))
  })

  it('case 6: a losing unverifiable slot, then the hook row ended with no mirror write', async () => {
    await losingSlotThenSwitch(() => store.getState().dropAgentStatus(PANE))
  })
})

describe('negative cases: nothing outside the renderer composition moves', () => {
  it('a losing slot crossing its deadline leaves the runtime mobile sync key unchanged', async () => {
    const lostAt = T0 - 2 * MINUTE
    const unverifiable = slot('working', 'unverifiable', {
      changedAt: lostAt,
      livenessChangedAt: lostAt
    })
    await act(async () => store.getState().applyProgramStatusPaneRows([slotRow(unverifiable)]))
    hook(store, 'working')
    const before = store.getState()
    const key = getRuntimeMobileSessionSyncKey(before, undefined, undefined, false)
    const epoch = before.programStatusEpoch
    // The slot crosses its deadline at 28 minutes; the hook row it loses to is fresh until 30.
    await act(async () => vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS - MINUTE))
    expect(store.getState().programStatusEpoch).toBe(epoch + 1)
    const after = store.getState()
    expect(canSkipRuntimeMobileSessionSyncKeyBuild(after, before, false)).toBe(true)
    expect(
      runtimeMobileSessionSyncKeysEqual(
        key,
        getRuntimeMobileSessionSyncKey(after, undefined, undefined, false)
      )
    ).toBe(true)
  })

  it('a slot change leaves the runtime mobile sync key equal', () => {
    const before = store.getState()
    act(() => store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))]))
    act(() => store.getState().setProgramStatusPreferred(true))
    const after = store.getState()
    expect(after.programStatusEpoch).toBeGreaterThan(before.programStatusEpoch)
    expect(canSkipRuntimeMobileSessionSyncKeyBuild(after, before, false)).toBe(true)
  })

  it('with no slot ever seen, the composed map and the token are the hook values themselves', async () => {
    hook(store, 'working')
    const state = store.getState()
    expect(selectComposedAgentStatusByPaneKey(state)).toBe(state.agentStatusByPaneKey)
    expect(agentStatusCompositionToken(state)).toBe(state.agentStatusEpoch)
    await act(async () => {})
    const slotTimers = vi.getTimerCount()
    await act(async () => store.getState().applyProgramStatusPaneRows([slotRow(null)]))
    expect(selectComposedAgentStatusByPaneKey(store.getState())).toBe(
      store.getState().agentStatusByPaneKey
    )
    expect(agentStatusCompositionToken(store.getState())).toBe(store.getState().agentStatusEpoch)
    // Only the pop-out bridge's throttle answers the write; no slot deadline stays armed.
    await readers.flushPublish()
    expect(vi.getTimerCount()).toBe(slotTimers)
  })

  it('a projected state without the composition inputs does not compile', () => {
    const state = store.getState()
    const {
      programStatusByPaneKey: _mirror,
      programStatusPreferred: _preferred,
      programStatusEpoch: _epoch,
      ...withoutComposition
    } = state
    // @ts-expect-error the rows cache state requires the composition inputs
    const rows: WorktreeAgentRowsState = withoutComposition
    // @ts-expect-error the activity summary input requires the composition inputs
    const activity: AgentActivityInput = withoutComposition
    // @ts-expect-error the worktree activity status state requires the composition inputs
    const statuses: Parameters<typeof selectWorktreeActivityStatuses>[0] = withoutComposition
    const freshness = createWorktreeAgentFreshnessSelector(WT)
    // @ts-expect-error the freshness selector state requires the composition inputs
    const freshnessState: Parameters<typeof freshness>[0] = withoutComposition
    // @ts-expect-error the bucket count state requires the composition inputs
    const buckets: AgentBucketCountState = { ...withoutComposition, settings: null }
    expect([rows, activity, statuses, freshnessState, buckets]).toHaveLength(5)
  })
})

describe('the main window owns the expiry of a slot-won card (31 minutes, simulated)', () => {
  async function openPopout() {
    const popout = renderHook(() => useDashboardSnapshot())
    await act(async () => {})
    dashboardApi.requestSnapshot.mockClear()
    dashboardApi.publishSnapshot.mockClear()
    return popout
  }

  it('a silent live slot never loops; its unverifiable deadline publishes exactly once', async () => {
    act(() => store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))]))
    await readers.flushPublish()
    const popout = await openPopout()
    await act(async () => vi.advanceTimersByTime(31 * MINUTE))
    expect(dashboardApi.requestSnapshot).not.toHaveBeenCalled()
    expect(dashboardApi.publishSnapshot).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    const card = popout.result.current.cards.find((c) => c.paneKey === PANE)
    expect(card).toMatchObject({
      dotState: 'working',
      statusExpiresAt: null,
      programStatusComposed: true
    })

    const lostAt = Date.now()
    const unverifiable = slot('working', 'unverifiable', {
      changedAt: T0 - 1_000,
      livenessChangedAt: lostAt
    })
    act(() => store.getState().applyProgramStatusPaneRows([slotRow(unverifiable)]))
    await readers.flushPublish()
    expect(dashboardApi.publishSnapshot).toHaveBeenCalledTimes(1)
    expect(readers.lastCard()).toMatchObject({
      dotState: 'working',
      statusExpiresAt: lostAt + AGENT_STATUS_STALE_AFTER_MS
    })
    const epoch = store.getState().programStatusEpoch
    await advanceTo(lostAt + AGENT_STATUS_STALE_AFTER_MS + 1)
    expect(store.getState().programStatusEpoch).toBe(epoch + 1)
    await readers.flushPublish()
    expect(dashboardApi.publishSnapshot).toHaveBeenCalledTimes(2)
    expect(readers.lastCard()).toMatchObject({ dotState: 'idle', statusExpiresAt: null })
    await act(async () => vi.advanceTimersByTime(60 * MINUTE))
    expect(dashboardApi.publishSnapshot).toHaveBeenCalledTimes(2)
    expect(dashboardApi.requestSnapshot).not.toHaveBeenCalled()
    popout.unmount()
  })

  it("a card the hook wins keeps today's path: one request at its own deadline", async () => {
    hook(store, 'working')
    act(() => store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))]))
    await readers.flushPublish()
    const popout = await openPopout()
    const card = popout.result.current.cards.find((c) => c.paneKey === PANE)
    expect(card).toMatchObject({ dotState: 'working', programStatusComposed: true })
    expect(card).not.toHaveProperty('statusExpiresAt')
    await act(async () => vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS - 2_000))
    expect(dashboardApi.requestSnapshot).not.toHaveBeenCalled()
    await act(async () => vi.advanceTimersByTime(4_000))
    expect(dashboardApi.requestSnapshot).toHaveBeenCalledTimes(1)
    popout.unmount()
  })
})
