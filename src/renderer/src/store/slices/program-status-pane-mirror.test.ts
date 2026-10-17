// @vitest-environment happy-dom

import { act } from 'react'
import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusIpcPayload
} from '../../../../shared/agent-status-types'
import type { DashboardCard, DashboardSnapshot } from '../../../../shared/dashboard-snapshot'
import type { ProgramStatusPaneIpcPayload } from '../../../../shared/program-status/program-status-pane-payload'
import type {
  ProgramStatusSlot,
  ProgramStatusSummaryState
} from '../../../../shared/program-status/program-status-slot'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildDashboardSnapshot } from '../../components/dashboard/build-dashboard-snapshot'
import { dashboardSnapshotInputsChanged } from '../../components/dashboard/useDashboardPopoutBridge'
import { patchDashboardSnapshotFromAgentStatus } from '../../components/dashboard-popout/dashboard-agent-status-patch'
import { useDashboardSnapshot } from '../../components/dashboard-popout/useDashboardSnapshot'
import { buildAgentStatusTabPrefixDropPatch } from './agent-status-drop-reducer'
import { syncProgramStatusPreferred } from './program-status-pane-mirror'
import { createTestStore } from './store-test-helpers'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = makePaneKey('tab1', LEAF)
const SIBLING = makePaneKey('tab1', OTHER_LEAF)
const OTHER_TAB_PANE = makePaneKey('tab2', LEAF)
const NOW = 1_000_000_000

function slot(aggregate: ProgramStatusSummaryState = 'done', generation = 2): ProgramStatusSlot {
  return {
    ptyId: 'pty1',
    incarnationId: 'inc-1',
    reportSeq: 1,
    liveness: 'live',
    livenessChangedAt: NOW - 10,
    view: 'now',
    shown: {
      summary: { aggregate, root: aggregate, childError: false },
      generation,
      changedAt: NOW - 10,
      rootChangedAt: NOW - 10
    }
  }
}

function row(
  paneKey: string,
  revision: number,
  programStatus: ProgramStatusSlot | null = slot()
): ProgramStatusPaneIpcPayload {
  return {
    programStatusOnly: true,
    paneKey,
    tabId: paneKey.split(':')[0],
    worktreeId: 'w1',
    revision,
    programStatus
  }
}

const api = {
  drop: vi.fn(),
  dropByTabPrefix: vi.fn(),
  retirePaneAuthority: vi.fn(),
  restorePaneAuthority: vi.fn()
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(window, {
    api: { agentStatus: api, gh: { enqueuePRRefresh: vi.fn(async () => undefined) } }
  })
})

describe('the program-status mirror applies slot rows by revision', () => {
  it('starts empty, dormant and outside every hook map', () => {
    const state = createTestStore().getState()
    expect(state.programStatusByPaneKey).toEqual({})
    expect(state.programStatusClosedPaneKeys).toEqual({})
    expect(state.programStatusPreferred).toBe(false)
    expect(state.programStatusEpoch).toBe(0)
  })

  it('a new row creates a record and bumps the composition epoch, never agentStatusEpoch', () => {
    const store = createTestStore()
    const hookMap = store.getState().agentStatusByPaneKey
    store.getState().applyProgramStatusPaneRows([row(PANE, 3)])
    const state = store.getState()
    expect(state.programStatusByPaneKey[PANE]).toEqual({
      revision: 3,
      tabId: 'tab1',
      worktreeId: 'w1',
      slot: slot()
    })
    expect(state.programStatusEpoch).toBe(1)
    expect(state.agentStatusEpoch).toBe(0)
    expect(state.agentStatusByPaneKey).toBe(hookMap)
  })

  it('an equal or lower revision leaves the mirror object untouched', () => {
    const store = createTestStore()
    store.getState().applyProgramStatusPaneRows([row(PANE, 3)])
    const mirror = store.getState().programStatusByPaneKey
    store.getState().applyProgramStatusPaneRows([row(PANE, 3, slot('working')), row(PANE, 2)])
    expect(store.getState().programStatusByPaneKey).toBe(mirror)
    expect(store.getState().programStatusEpoch).toBe(1)
  })

  it('a tombstone keeps its revision, so a racing older row cannot resurrect the slot', () => {
    const store = createTestStore()
    store.getState().applyProgramStatusPaneRows([row(PANE, 3)])
    store.getState().applyProgramStatusPaneRows([row(PANE, 5, null)])
    expect(store.getState().programStatusByPaneKey[PANE]).toMatchObject({ revision: 5, slot: null })
    expect(store.getState().programStatusEpoch).toBe(2)
    store.getState().applyProgramStatusPaneRows([row(PANE, 4)])
    expect(store.getState().programStatusByPaneKey[PANE]?.slot).toBeNull()
  })

  it('a tombstone over an invisible record moves no epoch', () => {
    const store = createTestStore()
    store.getState().applyProgramStatusPaneRows([row(PANE, 1, null), row(PANE, 2, null)])
    expect(store.getState().programStatusEpoch).toBe(0)
  })

  it('ignores a row for a closed pane and for a pane of a closed tab', () => {
    const store = createTestStore()
    store.getState().retireAgentPaneAuthority(PANE)
    store.getState().dropAgentStatusByTabPrefix('tab2')
    const mirror = store.getState().programStatusByPaneKey
    store.getState().applyProgramStatusPaneRows([row(PANE, 9), row(OTHER_TAB_PANE, 9)])
    expect(store.getState().programStatusByPaneKey).toBe(mirror)
  })
})

describe('the mirror follows the slot lifecycle, never the hook row', () => {
  function withSlots() {
    const store = createTestStore()
    store
      .getState()
      .applyProgramStatusPaneRows([row(PANE, 1), row(SIBLING, 2), row(OTHER_TAB_PANE, 3)])
    return store
  }

  it('a pane retirement deletes the record and records the closure', () => {
    const store = withSlots()
    const epoch = store.getState().programStatusEpoch
    store.getState().retireAgentPaneAuthority(PANE)
    expect(store.getState().programStatusByPaneKey[PANE]).toBeUndefined()
    expect(store.getState().programStatusClosedPaneKeys[PANE]).toBe(true)
    expect(store.getState().programStatusEpoch).toBe(epoch + 1)
    expect(store.getState().programStatusByPaneKey[SIBLING]).toBeDefined()
  })

  it('a restore lifts the closure before its IPC is sent', () => {
    const store = withSlots()
    store.getState().retireAgentPaneAuthority(PANE)
    api.restorePaneAuthority.mockImplementation(() => {
      expect(store.getState().programStatusClosedPaneKeys[PANE]).toBeUndefined()
    })
    store.getState().restoreAgentPaneAuthority(PANE)
    expect(api.restorePaneAuthority).toHaveBeenCalledTimes(1)
    store.getState().applyProgramStatusPaneRows([row(PANE, 7)])
    expect(store.getState().programStatusByPaneKey[PANE]?.revision).toBe(7)
  })

  it('a restore under a closed tab lifts nothing', () => {
    const store = withSlots()
    store.getState().retireAgentPaneAuthority(PANE)
    store.getState().dropAgentStatusByTabPrefix('tab1')
    store.getState().restoreAgentPaneAuthority(PANE)
    expect(store.getState().programStatusClosedPaneKeys[PANE]).toBe(true)
  })

  it('a tab close deletes the records of that tab and records their closure', () => {
    const store = withSlots()
    store.getState().dropAgentStatusByTabPrefix('tab1')
    const state = store.getState()
    expect(Object.keys(state.programStatusByPaneKey)).toEqual([OTHER_TAB_PANE])
    expect(state.programStatusClosedPaneKeys).toEqual({ [PANE]: true, [SIBLING]: true })
  })

  it('a pane-scoped drop closes only those panes, so a sibling keeps its record and rows', () => {
    const store = withSlots()
    const before = store.getState()
    const { patch } = buildAgentStatusTabPrefixDropPatch(before, 'tab1', [], {
      paneKeys: new Set([PANE])
    })
    store.setState(patch)
    const state = store.getState()
    expect(state.programStatusByPaneKey[PANE]).toBeUndefined()
    expect(state.programStatusByPaneKey[SIBLING]).toBe(before.programStatusByPaneKey[SIBLING])
    expect(state.programStatusClosedPaneKeys).toEqual({ [PANE]: true })
    store.getState().applyProgramStatusPaneRows([row(SIBLING, 9, slot('working'))])
    expect(store.getState().programStatusByPaneKey[SIBLING]?.revision).toBe(9)
    store.getState().applyProgramStatusPaneRows([row(PANE, 10)])
    expect(store.getState().programStatusByPaneKey[PANE]).toBeUndefined()
  })

  it('a pane-scoped drop closes a named pane that has no slot yet, so a late row stays out', () => {
    const store = createTestStore()
    store.getState().applyProgramStatusPaneRows([row(SIBLING, 3)])
    const before = store.getState()
    const { patch } = buildAgentStatusTabPrefixDropPatch(before, 'tab1', [], {
      paneKeys: new Set([PANE])
    })
    store.setState(patch)
    const state = store.getState()
    expect(state.programStatusByPaneKey[SIBLING]).toBe(before.programStatusByPaneKey[SIBLING])
    expect(state.programStatusClosedPaneKeys).toEqual({ [PANE]: true })
    store.getState().applyProgramStatusPaneRows([row(PANE, 4)])
    expect(store.getState().programStatusByPaneKey[PANE]).toBeUndefined()
    store.getState().applyProgramStatusPaneRows([row(SIBLING, 9, slot('working'))])
    expect(store.getState().programStatusByPaneKey[SIBLING]?.revision).toBe(9)
  })

  it('a removed pane deletes the record without recording a closure', () => {
    const store = withSlots()
    store.getState().dropAgentStatus(PANE, { paneRemoved: true })
    expect(store.getState().programStatusByPaneKey[PANE]).toBeUndefined()
    expect(store.getState().programStatusClosedPaneKeys).toEqual({})
  })

  it('a dismissal, interrupt or command-end drop of the hook row leaves the mirror alone', () => {
    const store = withSlots()
    store.getState().setAgentStatus(PANE, { state: 'working', prompt: 'p', agentType: 'claude' })
    const mirror = store.getState().programStatusByPaneKey
    const epoch = store.getState().programStatusEpoch
    store.getState().dropAgentStatus(PANE)
    expect(store.getState().programStatusByPaneKey).toBe(mirror)
    expect(store.getState().programStatusEpoch).toBe(epoch)
  })

  it('a new hook row neither touches the mirror nor blocks a later slot row', () => {
    const store = withSlots()
    store.getState().setAgentStatus(PANE, { state: 'working', prompt: 'p', agentType: 'claude' })
    store.getState().dropAgentStatus(PANE)
    const mirror = store.getState().programStatusByPaneKey
    store.getState().setAgentStatus(PANE, { state: 'done', prompt: 'p', agentType: 'claude' })
    expect(store.getState().programStatusByPaneKey).toBe(mirror)
    store.getState().applyProgramStatusPaneRows([row(PANE, 8, slot('working'))])
    expect(store.getState().programStatusByPaneKey[PANE]?.slot?.shown.summary.aggregate).toBe(
      'working'
    )
  })
})

describe('the preference is mirrored as a primitive', () => {
  const preferring = (store: ReturnType<typeof createTestStore>, preferred: boolean) =>
    Object.assign({}, store.getState().settings, { agentProgramStatusPreferred: preferred })

  it('follows the setting and bumps the epoch only while a visible slot exists', () => {
    const store = createTestStore()
    store.setState({ settings: preferring(store, true) })
    syncProgramStatusPreferred(store.getState())
    expect(store.getState().programStatusPreferred).toBe(true)
    expect(store.getState().programStatusEpoch).toBe(0)
    store.getState().applyProgramStatusPaneRows([row(PANE, 1)])
    const previous = store.getState()
    store.setState({ settings: preferring(store, false) })
    syncProgramStatusPreferred(store.getState(), previous)
    expect(store.getState().programStatusPreferred).toBe(false)
    expect(store.getState().programStatusEpoch).toBe(2)
  })

  it('an unrelated settings write changes nothing', () => {
    const store = createTestStore()
    const previous = store.getState()
    store.setState({ settings: preferring(store, false) })
    const before = store.getState()
    syncProgramStatusPreferred(store.getState(), previous)
    expect(store.getState()).toBe(before)
  })
})

describe('acknowledgeProgramStatusForPane', () => {
  it('sets the local hide and sends the acknowledgement of the visible slot', () => {
    const store = createTestStore()
    store.getState().applyProgramStatusPaneRows([row(PANE, 1)])
    store.getState().acknowledgeProgramStatusForPane(PANE)
    const record = store.getState().programStatusByPaneKey[PANE]
    expect(record?.localHide).toEqual({ incarnationId: 'inc-1', view: 'now', generation: 2 })
    expect(store.getState().programStatusEpoch).toBe(2)
    expect(api.drop).toHaveBeenCalledWith(PANE, {
      incarnationId: 'inc-1',
      view: 'now',
      generation: 2
    })
  })

  it('does nothing without a visible slot', () => {
    const store = createTestStore()
    store.getState().acknowledgeProgramStatusForPane(PANE)
    store.getState().applyProgramStatusPaneRows([row(PANE, 1, null)])
    store.getState().acknowledgeProgramStatusForPane(PANE)
    store.getState().applyProgramStatusPaneRows([row(SIBLING, 1)])
    store.getState().acknowledgeProgramStatusForPane(SIBLING)
    store.getState().acknowledgeProgramStatusForPane(SIBLING)
    expect(api.drop).toHaveBeenCalledTimes(1)
  })

  it('the hide holds until a newer row replaces the record, and never hides another generation', () => {
    const store = createTestStore()
    store.getState().applyProgramStatusPaneRows([row(PANE, 1)])
    store.getState().acknowledgeProgramStatusForPane(PANE)
    store.getState().applyProgramStatusPaneRows([row(PANE, 1)])
    expect(store.getState().programStatusByPaneKey[PANE]?.localHide).toBeDefined()
    store.getState().applyProgramStatusPaneRows([row(PANE, 2, slot('done', 5))])
    expect(store.getState().programStatusByPaneKey[PANE]?.localHide).toBeUndefined()
  })
})

describe('the IPC bridge narrows slot rows before the hook applicator', () => {
  afterEach(() => {
    vi.doUnmock('../../store')
    vi.doUnmock('../../hooks/agent-hook-completion-notifications')
    vi.resetModules()
  })

  async function bridgeWith(snapshotRows: (AgentStatusIpcPayload | ProgramStatusPaneIpcPayload)[]) {
    const store = createTestStore()
    let onSet: ((data: AgentStatusIpcPayload | ProgramStatusPaneIpcPayload) => void) | null = null
    vi.doMock('../../store', () => ({ useAppStore: store }))
    vi.doMock('../../hooks/agent-hook-completion-notifications', () => ({
      observeAgentHookCompletionForNotification: vi.fn(),
      syncAgentHookCompletionNotificationsForStoreUpdate: vi.fn()
    }))
    Object.assign(window, {
      api: {
        agentStatus: {
          ...api,
          onSet: (listener: typeof onSet) => {
            onSet = listener
            return () => {}
          },
          getSnapshot: async () => snapshotRows
        }
      }
    })
    const { registerAgentStatusIpcBridge } =
      await import('../../hooks/ipc-events/agent-status-ipc-bridge')
    const bridge = registerAgentStatusIpcBridge([])
    return {
      store,
      bridge,
      push: (data: AgentStatusIpcPayload | ProgramStatusPaneIpcPayload) => onSet?.(data)
    }
  }

  it('a live slot row lands in the mirror and never in the hook map', async () => {
    const { store, bridge, push } = await bridgeWith([])
    const hookMap = store.getState().agentStatusByPaneKey
    push(row(PANE, 1))
    expect(store.getState().programStatusByPaneKey[PANE]?.revision).toBe(1)
    expect(store.getState().agentStatusByPaneKey).toBe(hookMap)
    bridge.disposeAsyncState()
    bridge.unsubscribeStore()
  })

  it('the snapshot pull splits slot rows from hook rows', async () => {
    const { store, bridge } = await bridgeWith([row(PANE, 4)])
    store.setState({ workspaceSessionReady: true })
    await vi.waitFor(() => expect(store.getState().programStatusByPaneKey[PANE]?.revision).toBe(4))
    expect(store.getState().agentStatusByPaneKey[PANE]).toBeUndefined()
    bridge.disposeAsyncState()
    bridge.unsubscribeStore()
  })

  it('mirrors the preference once installed', async () => {
    const { store, bridge } = await bridgeWith([])
    store.setState({
      settings: Object.assign({}, store.getState().settings, { agentProgramStatusPreferred: true })
    })
    expect(store.getState().programStatusPreferred).toBe(true)
    bridge.disposeAsyncState()
    bridge.unsubscribeStore()
  })
})

function worktree(): Worktree {
  return {
    id: 'w1',
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
    lastActivityAt: NOW
  }
}

function tab(): TerminalTab {
  return {
    id: 'tab1',
    ptyId: 'pty1',
    worktreeId: 'w1',
    title: 'agent',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: NOW
  }
}

function boardStore() {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo', badgeColor: '#000', addedAt: NOW }],
    worktreesByRepo: { r1: [worktree()] },
    tabsByWorktree: { w1: [tab()] },
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
  store
    .getState()
    .setAgentStatus(
      PANE,
      { state: 'working', prompt: 'build it', agentType: 'claude' },
      undefined,
      { updatedAt: NOW - 1_000, stateStartedAt: NOW - 1_000 },
      { tabId: 'tab1', worktreeId: 'w1' }
    )
  return store
}

describe('the main window marks composed cards for the pop-out', () => {
  it('marks a card whose pane has a visible slot, and only while it is visible', () => {
    const store = boardStore()
    store.getState().applyProgramStatusPaneRows([row(PANE, 1)])
    const marked = buildDashboardSnapshot(store.getState(), NOW).cards
    expect(marked.find((card) => card.paneKey === PANE)?.programStatusComposed).toBe(true)
    store.getState().acknowledgeProgramStatusForPane(PANE)
    const hidden = buildDashboardSnapshot(store.getState(), NOW).cards
    expect(hidden.find((card) => card.paneKey === PANE)).not.toHaveProperty('programStatusComposed')
  })

  it('republishes on a slot change, a preference flip, an epoch bump and a slot pane hook change', () => {
    const store = boardStore()
    const base = store.getState()
    store.getState().applyProgramStatusPaneRows([row(PANE, 1)])
    const withSlot = store.getState()
    expect(dashboardSnapshotInputsChanged(withSlot, base)).toBe(true)
    expect(
      dashboardSnapshotInputsChanged({ ...withSlot, programStatusPreferred: true }, withSlot)
    ).toBe(true)
    expect(dashboardSnapshotInputsChanged({ ...withSlot, programStatusEpoch: 9 }, withSlot)).toBe(
      true
    )
    store
      .getState()
      .setAgentStatus(PANE, { state: 'done', prompt: 'build it', agentType: 'claude' })
    expect(dashboardSnapshotInputsChanged(store.getState(), withSlot)).toBe(true)
  })

  it('a hook change on a pane without a visible slot stays off the publish path', () => {
    const store = boardStore()
    store.getState().applyProgramStatusPaneRows([row(SIBLING, 1)])
    const before = store.getState()
    store
      .getState()
      .setAgentStatus(PANE, { state: 'done', prompt: 'build it', agentType: 'claude' })
    expect(dashboardSnapshotInputsChanged(store.getState(), before)).toBe(false)
  })
})

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: PANE,
    ptyId: 'pty1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 't',
    repoId: 'r1',
    worktreeId: 'w1',
    tabId: 'tab1',
    leafId: LEAF,
    repoName: 'Repo',
    worktreeName: 'wt',
    startedAt: 1,
    finishedAt: null,
    stateChangedAt: 1,
    statusUpdatedAt: 1,
    unseen: false,
    ...overrides
  }
}

describe('the pop-out never patches a composed card', () => {
  const hookEvent: AgentStatusIpcPayload = {
    paneKey: PANE,
    state: 'done',
    prompt: 'later',
    agentType: 'claude',
    connectionId: null,
    receivedAt: 50,
    stateStartedAt: 50
  }

  it('a marked card is matched and returned unchanged', () => {
    const snapshot: DashboardSnapshot = {
      generatedAt: 1,
      cards: [card({ programStatusComposed: true })]
    }
    const result = patchDashboardSnapshotFromAgentStatus(snapshot, hookEvent)
    expect(result).toEqual({ matched: true, snapshot })
    expect(result.snapshot).toBe(snapshot)
  })

  it('an unmarked card is patched exactly as before', () => {
    const snapshot: DashboardSnapshot = { generatedAt: 1, cards: [card()] }
    const result = patchDashboardSnapshotFromAgentStatus(snapshot, hookEvent)
    expect(result.snapshot.cards[0]).toMatchObject({ dotState: 'done', statusUpdatedAt: 50 })
  })
})

describe('the pop-out ignores slot rows and never derives an expiry the main window owns', () => {
  let onSnapshot: (next: DashboardSnapshot) => void = () => {}
  let onSet: (data: AgentStatusIpcPayload | ProgramStatusPaneIpcPayload) => void = () => {}
  const requestSnapshot = vi.fn(async () => {})

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    Object.assign(window, {
      api: {
        dashboard: {
          onSnapshot: (listener: typeof onSnapshot) => {
            onSnapshot = listener
            return () => {}
          },
          requestSnapshot
        },
        agentStatus: {
          onSet: (listener: typeof onSet) => {
            onSet = listener
            return () => {}
          },
          onClear: () => () => {}
        }
      }
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function mount(cards: DashboardCard[]) {
    const hook = renderHook(() => useDashboardSnapshot())
    act(() => onSnapshot({ generatedAt: NOW, cards }))
    requestSnapshot.mockClear()
    return hook
  }

  it('a slot row on the shared channel is ignored: no patch and no refresh request', () => {
    const hook = mount([card({ statusUpdatedAt: NOW })])
    const before = hook.result.current
    act(() => onSet(row(PANE, 1)))
    act(() => vi.advanceTimersByTime(5_000))
    expect(requestSnapshot).not.toHaveBeenCalled()
    expect(hook.result.current).toBe(before)
  })

  it('a card carrying statusExpiresAt schedules no stale refresh, however long the silence', () => {
    mount([card({ statusUpdatedAt: NOW, statusExpiresAt: null, programStatusComposed: true })])
    act(() => vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 60_000))
    expect(requestSnapshot).not.toHaveBeenCalled()
  })

  it("a hook card keeps today's deadline: one request after it goes stale", () => {
    mount([card({ statusUpdatedAt: NOW })])
    act(() => vi.advanceTimersByTime(AGENT_STATUS_STALE_AFTER_MS + 2_000))
    expect(requestSnapshot).toHaveBeenCalledTimes(1)
  })
})

describe('dormant: with an empty slot table nothing changes', () => {
  it('cards carry no marker and equal the cards of a store without the mirror fields', () => {
    const store = boardStore()
    const state = store.getState()
    const { programStatusByPaneKey: _mirror, ...withoutMirror } = state
    const cards = buildDashboardSnapshot(state, NOW).cards
    expect(cards).toHaveLength(1)
    expect(cards[0]).not.toHaveProperty('programStatusComposed')
    expect(cards[0]).not.toHaveProperty('statusExpiresAt')
    // @ts-expect-error a store from before the composition has no mirror; it must still build
    expect(cards).toEqual(buildDashboardSnapshot(withoutMirror, NOW).cards)
  })

  it('a hook write republishes exactly when it did before', () => {
    const store = boardStore()
    const before = store.getState()
    store
      .getState()
      .setAgentStatus(PANE, { state: 'done', prompt: 'build it', agentType: 'claude' })
    expect(dashboardSnapshotInputsChanged(store.getState(), before)).toBe(false)
    expect(dashboardSnapshotInputsChanged({ ...before, tabsByWorktree: {} }, before)).toBe(true)
  })
})
