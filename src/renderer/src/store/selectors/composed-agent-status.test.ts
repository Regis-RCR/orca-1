// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  isFreshNonDoneAgentStatus,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'
import { programStatusEntryFromSlot } from '../../../../shared/program-status/compose-agent-status-entry'
import {
  composedEntryStaleAt,
  selectExpiringProgramStatusEntries
} from '../../../../shared/program-status/program-status-expiry'
import {
  PROGRAM_STATUS_ENTRY_TABLE,
  type ProgramStatusEntryTableRow
} from '../../../../shared/program-status/program-status-entry-table.test-support'
import type { ProgramStatusPaneIpcPayload } from '../../../../shared/program-status/program-status-pane-payload'
import type {
  ProgramStatusLiveness,
  ProgramStatusSlot,
  ProgramStatusSummaryState
} from '../../../../shared/program-status/program-status-slot'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { createTestStore } from '../slices/store-test-helpers'
import { resetAgentPaneAuthorityAliasesForTests } from '../slices/agent-pane-authority'

type TestStore = ReturnType<typeof createTestStore>
const holder: { store?: TestStore } = vi.hoisted(() => ({}))
const undoToast = vi.hoisted(() => ({ show: vi.fn() }))
vi.mock('sonner', () => ({ toast: undoToast.show }))

vi.mock('@/store', () => {
  const current = (): TestStore => {
    if (!holder.store) {
      throw new Error('no test store installed')
    }
    return holder.store
  }
  const useAppStore = <T>(selector: (state: AppState) => T): T => current()(selector)
  return { useAppStore: Object.assign(useAppStore, { getState: () => current().getState() }) }
})

import { isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { agentRowDisplayDotState } from '@/lib/agent-row-dot-state'
import {
  applyAgentPaneActivityFlags,
  type AgentPaneActivityFlags
} from '@/lib/agent-pane-activity-flags'
import {
  dashboardRowBucketProjection,
  readAgentRowTurnRecords
} from '../../components/dashboard/dashboard-row-bucket'
import { selectWorktreeAgentRowsCached } from '../../components/dashboard/worktree-agent-rows-cache'
import { buildDashboardBucketCounts } from '../../components/dashboard/build-dashboard-bucket-counts'
import { buildDashboardSnapshot } from '../../components/dashboard/build-dashboard-snapshot'
import { selectWorktreeActivityStatuses } from '../../components/sidebar/use-worktree-activity-statuses'
import {
  CLEAR_COMPLETED_EVICTION_FALLBACK_MS,
  clearActivityThread,
  clearCompletedActivity,
  flushPendingClearCompletedEvictions
} from '../../components/activity/activity-clear-completed'
import type { AgentPaneThread } from '../../components/activity/activity-thread-types'
import {
  agentStatusCompositionToken,
  selectComposedAgentStatusByPaneKey
} from './composed-agent-status'

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const PANE = makePaneKey('tab1', LEAF)
const OTHER = makePaneKey('tab1', OTHER_LEAF)
const NOW = 1_800_000_000_000
const WT = 'w1'

function slot(
  aggregate: ProgramStatusSummaryState,
  liveness: ProgramStatusLiveness = 'live',
  root: ProgramStatusSummaryState | null = aggregate,
  times = { changedAt: NOW - 1_000, livenessChangedAt: NOW - 500 }
): ProgramStatusSlot {
  return {
    ptyId: 'pty1',
    incarnationId: 'inc-1',
    reportSeq: 1,
    liveness,
    livenessChangedAt: times.livenessChangedAt,
    view: liveness === 'exited' ? 'onExit' : 'now',
    shown: {
      summary: { aggregate, root, childError: false },
      generation: 4,
      changedAt: times.changedAt,
      rootChangedAt: root === null ? null : times.changedAt - 100
    }
  }
}

let revision = 0
function slotRow(
  programStatus: ProgramStatusSlot | null,
  paneKey = PANE
): ProgramStatusPaneIpcPayload {
  revision += 1
  return {
    programStatusOnly: true,
    paneKey,
    tabId: 'tab1',
    worktreeId: WT,
    revision,
    programStatus
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
  createdAt: NOW
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
    lastActivityAt: NOW
  }
}

function boardStore(): TestStore {
  const store = createTestStore()
  store.setState({
    repos: [{ id: 'r1', path: '/r1', displayName: 'Repo', badgeColor: '#000', addedAt: NOW }],
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

function setHook(
  store: TestStore,
  paneKey: string,
  state: AgentStatusEntry['state'],
  extra: Partial<Parameters<AppState['setAgentStatus']>[1]> = {}
): void {
  store
    .getState()
    .setAgentStatus(
      paneKey,
      { state, prompt: 'hook turn', agentType: 'claude', ...extra },
      undefined,
      { updatedAt: NOW - 1_000, stateStartedAt: NOW - 1_000 },
      { tabId: 'tab1', worktreeId: WT }
    )
}

beforeEach(() => {
  resetAgentPaneAuthorityAliasesForTests()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  Object.assign(window, {
    api: {
      agentStatus: { drop: vi.fn(), retirePaneAuthority: vi.fn(), restorePaneAuthority: vi.fn() },
      gh: { enqueuePRRefresh: vi.fn(async () => undefined) }
    }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('selectComposedAgentStatusByPaneKey', () => {
  it('is the hook map itself while no slot is visible: empty, tombstoned or hidden', () => {
    const store = boardStore()
    setHook(store, PANE, 'working')
    expect(selectComposedAgentStatusByPaneKey(store.getState())).toBe(
      store.getState().agentStatusByPaneKey
    )
    store.getState().applyProgramStatusPaneRows([slotRow(slot('done'), OTHER)])
    store.getState().acknowledgeProgramStatusForPane(OTHER)
    expect(selectComposedAgentStatusByPaneKey(store.getState())).toBe(
      store.getState().agentStatusByPaneKey
    )
    store.getState().applyProgramStatusPaneRows([slotRow(null, OTHER)])
    expect(selectComposedAgentStatusByPaneKey(store.getState())).toBe(
      store.getState().agentStatusByPaneKey
    )
  })

  it('adds the entry of a slot-only pane and leaves the hook map untouched', () => {
    const store = boardStore()
    setHook(store, OTHER, 'working')
    const hookMap = store.getState().agentStatusByPaneKey
    store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))])
    const composed = selectComposedAgentStatusByPaneKey(store.getState())
    expect(store.getState().agentStatusByPaneKey).toBe(hookMap)
    expect(composed).not.toBe(hookMap)
    expect(composed[OTHER]).toBe(hookMap[OTHER])
    expect(composed[PANE]).toEqual(
      programStatusEntryFromSlot({
        paneKey: PANE,
        tabId: 'tab1',
        worktreeId: WT,
        slot: slot('working')
      })
    )
    expect(hookMap[PANE]).toBeUndefined()
  })

  it('hooks-first keeps a valid hook row and yields only for a seed or an unconfirmed row', () => {
    const store = boardStore()
    setHook(store, PANE, 'blocked')
    store.getState().applyProgramStatusPaneRows([slotRow(slot('done'))])
    const hookEntry = store.getState().agentStatusByPaneKey[PANE]
    expect(selectComposedAgentStatusByPaneKey(store.getState())[PANE]).toBe(hookEntry)
    store.setState({
      agentStatusByPaneKey: { [PANE]: { ...hookEntry, restoredUnconfirmed: true } }
    })
    expect(selectComposedAgentStatusByPaneKey(store.getState())[PANE]?.state).toBe('done')
    store.setState({ agentStatusByPaneKey: { [PANE]: hookEntry } })
    store.getState().setProgramStatusPreferred(true)
    expect(selectComposedAgentStatusByPaneKey(store.getState())[PANE]?.state).toBe('done')
  })

  it('memoizes: same inputs, same map; a hook ping elsewhere keeps the slot entry object', () => {
    const store = boardStore()
    store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))])
    setHook(store, OTHER, 'working')
    const first = selectComposedAgentStatusByPaneKey(store.getState())
    expect(selectComposedAgentStatusByPaneKey(store.getState())).toBe(first)
    setHook(store, OTHER, 'blocked')
    const second = selectComposedAgentStatusByPaneKey(store.getState())
    expect(second).not.toBe(first)
    expect(second[PANE]).toBe(first[PANE])
    expect(second[OTHER]?.state).toBe('blocked')
  })
})

describe('agentStatusCompositionToken', () => {
  it('is agentStatusEpoch until a slot ever composed, then one frozen object per pair', () => {
    const store = boardStore()
    expect(agentStatusCompositionToken(store.getState())).toBe(store.getState().agentStatusEpoch)
    store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))])
    const token = agentStatusCompositionToken(store.getState())
    expect(token).toEqual({
      agentStatusEpoch: store.getState().agentStatusEpoch,
      programStatusEpoch: 1
    })
    expect(Object.isFrozen(token)).toBe(true)
    expect(agentStatusCompositionToken(store.getState())).toBe(token)
    store.getState().setProgramStatusPreferred(true)
    expect(agentStatusCompositionToken(store.getState())).not.toBe(token)
  })
})

describe('the published expiry and the slot scheduler candidates', () => {
  it('composedEntryStaleAt: no deadline while live, else the last verified instant plus the window', () => {
    const live = programStatusEntryFromSlot({ paneKey: PANE, slot: slot('working') })
    const lost = programStatusEntryFromSlot({
      paneKey: PANE,
      slot: slot('working', 'unverifiable')
    })
    expect(composedEntryStaleAt(live)).toBeNull()
    expect(composedEntryStaleAt(lost)).toBe(NOW - 500 + AGENT_STATUS_STALE_AFTER_MS)
  })

  it('candidates: every visible non-live slot, whoever wins the pane, memoized on the mirror', () => {
    const store = boardStore()
    setHook(store, OTHER, 'working')
    store
      .getState()
      .applyProgramStatusPaneRows([
        slotRow(slot('working')),
        slotRow(slot('working', 'unverifiable'), OTHER)
      ])
    const mirror = store.getState().programStatusByPaneKey
    const candidates = selectExpiringProgramStatusEntries(mirror)
    expect(Object.keys(candidates)).toEqual([OTHER])
    expect(selectExpiringProgramStatusEntries(mirror)).toBe(candidates)
    store.getState().setProgramStatusPreferred(true)
    expect(selectExpiringProgramStatusEntries(store.getState().programStatusByPaneKey)).toBe(
      candidates
    )
    store.getState().acknowledgeProgramStatusForPane(OTHER)
    expect(selectExpiringProgramStatusEntries(store.getState().programStatusByPaneKey)).toEqual({})
  })
})

function paneRow(store: TestStore, now = NOW) {
  const state = store.getState()
  const row = selectWorktreeAgentRowsCached({
    state,
    worktreeId: WT,
    orchestration: {},
    now,
    generation: agentStatusCompositionToken(state)
  }).find((candidate) => candidate.paneKey === PANE)
  if (!row) {
    throw new Error('no row for the pane')
  }
  return row
}

function readers(store: TestStore, now = NOW) {
  const row = paneRow(store, now)
  return {
    rowDot: agentRowDisplayDotState(row),
    dashboardDot: dashboardRowBucketProjection(row, readAgentRowTurnRecords(store.getState()))
      .dotState,
    worktreeCard: selectWorktreeActivityStatuses(store.getState(), [WT]).get(WT)
  }
}

function hookStoreFor(row: ProgramStatusEntryTableRow): TestStore {
  const store = boardStore()
  setHook(
    store,
    PANE,
    row.state,
    row.outcome
      ? { mainAgent: { state: 'done', outcome: row.outcome, stateStartedAt: NOW - 1_100 } }
      : {}
  )
  return store
}

describe('a composed slot reads like a hook entry through the real store', () => {
  it.each(PROGRAM_STATUS_ENTRY_TABLE)('aggregate $aggregate with root $root', (row) => {
    const hookReaders = readers(hookStoreFor(row))
    const store = boardStore()
    store.getState().applyProgramStatusPaneRows([slotRow(slot(row.aggregate, 'live', row.root))])
    const slotReaders = readers(store)
    expect(slotReaders).toEqual(hookReaders)
    expect(slotReaders).toEqual({
      rowDot: row.rowDot,
      dashboardDot: row.dashboardDot,
      worktreeCard: row.worktreeCard
    })
  })

  it.each([
    ['fresh', NOW],
    ['older than 30 minutes', NOW + AGENT_STATUS_STALE_AFTER_MS + 60_000]
  ])('an idle summary, %s, is an idle row, never done', (_label, now) => {
    const store = boardStore()
    store.getState().applyProgramStatusPaneRows([slotRow(slot('idle', 'exited'))])
    const row = paneRow(store, now)
    expect(row.state).toBe('idle')
    expect(agentRowDisplayDotState(row)).toBe('idle')
    expect(
      dashboardRowBucketProjection(row, readAgentRowTurnRecords(store.getState())).dotState
    ).toBe('idle')
    const counts = buildDashboardBucketCounts(store.getState(), now)
    expect(counts.done).toBe(0)
    expect(counts.idle).toBe(1)
    expect(selectWorktreeActivityStatuses(store.getState(), [WT]).get(WT)).toBe('active')
  })
})

describe('freshness checks honour a live slot like a host-owned row', () => {
  it('a live composed entry silent for two hours is still fresh; a non-live one is not', () => {
    const later = NOW + 2 * 60 * 60_000
    const live = programStatusEntryFromSlot({ paneKey: PANE, slot: slot('working') })
    const lost = programStatusEntryFromSlot({
      paneKey: PANE,
      slot: slot('working', 'unverifiable')
    })
    expect(isFreshNonDoneAgentStatus(live, later)).toBe(true)
    expect(isExplicitAgentStatusFresh(live, later, AGENT_STATUS_STALE_AFTER_MS)).toBe(true)
    expect(isFreshNonDoneAgentStatus(lost, later)).toBe(false)
    expect(isExplicitAgentStatusFresh(lost, later, AGENT_STATUS_STALE_AFTER_MS)).toBe(false)
  })

  it('a resting idle entry raises no live-done flag on a card or a tab', () => {
    const flags: AgentPaneActivityFlags = {
      hasPermission: false,
      hasLiveWorking: false,
      hasLiveMonitoring: false,
      hasFailed: false,
      hasInterrupted: false,
      hasUnconfirmed: false,
      hasLiveDone: false
    }
    applyAgentPaneActivityFlags(
      flags,
      programStatusEntryFromSlot({ paneKey: PANE, slot: slot('idle') })
    )
    expect(flags.hasLiveDone).toBe(false)
    applyAgentPaneActivityFlags(
      flags,
      programStatusEntryFromSlot({ paneKey: PANE, slot: slot('done') })
    )
    expect(flags.hasLiveDone).toBe(true)
  })
})

describe('the expiry a slot-won dashboard card carries', () => {
  function card(store: TestStore) {
    return buildDashboardSnapshot(store.getState(), NOW).cards.find((c) => c.paneKey === PANE)
  }

  it('live: null; unverifiable and active: its deadline; done: null', () => {
    const store = boardStore()
    store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))])
    expect(card(store)).toMatchObject({ programStatusComposed: true, statusExpiresAt: null })
    store.getState().applyProgramStatusPaneRows([slotRow(slot('working', 'unverifiable'))])
    expect(card(store)?.statusExpiresAt).toBe(NOW - 500 + AGENT_STATUS_STALE_AFTER_MS)
    store.getState().applyProgramStatusPaneRows([slotRow(slot('done', 'unverifiable'))])
    expect(card(store)?.statusExpiresAt).toBeNull()
  })

  it('a card the hook wins carries no expiry, marked or not', () => {
    const store = boardStore()
    setHook(store, PANE, 'working')
    expect(card(store)).not.toHaveProperty('statusExpiresAt')
    store.getState().applyProgramStatusPaneRows([slotRow(slot('working', 'unverifiable'))])
    expect(card(store)).toMatchObject({ programStatusComposed: true, dotState: 'working' })
    expect(card(store)).not.toHaveProperty('statusExpiresAt')
  })
})

describe('clear completed dismisses a finished slot by its own acknowledgement', () => {
  function thread(): AgentPaneThread {
    return {
      paneKey: PANE,
      paneTitle: 'agent',
      worktree: worktree(),
      repo: null,
      tab: TAB,
      agentType: 'claude',
      currentAgentState: null,
      currentAgentEntry: null,
      responsePreview: '',
      latestTimestamp: NOW - 1_000,
      latestEvent: null,
      events: [],
      unread: false
    }
  }

  // Why error too: the composition reads an error slot as finished, so its thread is clearable.
  it.each(['done', 'idle', 'error'] as const)('a visible %s slot is acknowledged', (aggregate) => {
    const store = boardStore()
    store.getState().applyProgramStatusPaneRows([slotRow(slot(aggregate))])
    expect(clearActivityThread(thread())).toBe(true)
    expect(store.getState().programStatusByPaneKey[PANE]?.localHide).toEqual({
      incarnationId: 'inc-1',
      view: 'now',
      generation: 4
    })
    expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, {
      incarnationId: 'inc-1',
      view: 'now',
      generation: 4
    })
  })

  it('a working slot is left alone, and a pane without a slot sends nothing', () => {
    const store = boardStore()
    store.getState().applyProgramStatusPaneRows([slotRow(slot('working'))])
    expect(clearActivityThread(thread())).toBe(true)
    expect(store.getState().programStatusByPaneKey[PANE]?.localHide).toBeUndefined()
    boardStore()
    expect(clearActivityThread(thread())).toBe(true)
    expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
  })

  describe('with the undo toast', () => {
    const ACK = { incarnationId: 'inc-1', view: 'now', generation: 4 }
    const shown = (store: TestStore) => selectComposedAgentStatusByPaneKey(store.getState())[PANE]
    function clearWithToast(store: TestStore, aggregate: 'done' | 'error' = 'done') {
      store.getState().applyProgramStatusPaneRows([slotRow(slot(aggregate))])
      expect(clearCompletedActivity([thread()])).toBe(true)
      const options = undoToast.show.mock.calls.at(-1)?.[1]
      return {
        undo: () => options.action.onClick(),
        dismiss: () => options.onDismiss(),
        autoClose: () => options.onAutoClose()
      }
    }

    // Why error too: a failed result is finished, so its ack is deferred and undoable alike.
    const FINISHED = ['done', 'error'] as const

    it.each(FINISHED)('hides a finished %s slot at once, its ack deferred', (aggregate) => {
      const store = boardStore()
      const toast = clearWithToast(store, aggregate)
      expect(shown(store)).toBeUndefined()
      expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
      toast.dismiss()
      expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, ACK)
    })

    it.each(FINISHED)(
      'Undo restores a finished %s slot; a later close sends nothing',
      (aggregate) => {
        const store = boardStore()
        const toast = clearWithToast(store, aggregate)
        toast.undo()
        expect(shown(store)).toMatchObject({ state: 'done' })
        expect(store.getState().programStatusByPaneKey[PANE]?.localHide).toBeUndefined()
        toast.dismiss()
        expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
      }
    )

    it.each([
      ['dismissed', (toast: ReturnType<typeof clearWithToast>) => toast.dismiss()],
      ['auto-closed', (toast: ReturnType<typeof clearWithToast>) => toast.autoClose()],
      ['left to the fallback', () => vi.advanceTimersByTime(CLEAR_COMPLETED_EVICTION_FALLBACK_MS)],
      ['flushed on pagehide', () => flushPendingClearCompletedEvictions()]
    ])('acknowledges once the toast is %s', (_name, close) => {
      const store = boardStore()
      const toast = clearWithToast(store)
      close(toast)
      toast.dismiss()
      expect(window.api.agentStatus.drop).toHaveBeenCalledTimes(1)
      expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, ACK)
      expect(shown(store)).toBeUndefined()
    })

    it('never acknowledges a newer generation shown before the toast closes', () => {
      const store = boardStore()
      const toast = clearWithToast(store)
      const newer = slot('done')
      store
        .getState()
        .applyProgramStatusPaneRows([
          slotRow({ ...newer, shown: { ...newer.shown, generation: 5 } })
        ])
      toast.dismiss()
      expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
      expect(shown(store)).toMatchObject({ state: 'done' })
    })

    it('keeps the cleared generation hidden across a republish, then acknowledges it', () => {
      const store = boardStore()
      const toast = clearWithToast(store)
      store.getState().applyProgramStatusPaneRows([slotRow(slot('done'))])
      expect(shown(store)).toBeUndefined()
      toast.dismiss()
      expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, ACK)
    })

    describe('when the PTY exits while Undo is offered', () => {
      // The host's slot names the `now` view the exit followed, as the producer proved it.
      const exitedAs = (
        aggregate: ProgramStatusSummaryState,
        exitedFrom: ProgramStatusSlot['exitedFrom'] | null = slot('done').shown
      ) => {
        const exited = slot(aggregate, 'exited')
        return slotRow({
          ...exited,
          shown: { ...exited.shown, generation: 6 },
          ...(exitedFrom ? { exitedFrom } : {})
        })
      }

      it('keeps an unchanged result hidden, then sends the ack it hid for the host to carry', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store.getState().applyProgramStatusPaneRows([exitedAs('done')])
        expect(shown(store)).toBeUndefined()
        toast.dismiss()
        expect(window.api.agentStatus.drop).toHaveBeenCalledTimes(1)
        expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, ACK)
      })

      it.each([
        ['no proof of the view the exit followed', null],
        ['a proof of another generation', { ...slot('done').shown, generation: 5 }]
      ])('never carries the hide on %s, whatever it remembers', (_name, exitedFrom) => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store.getState().applyProgramStatusPaneRows([exitedAs('done', exitedFrom)])
        expect(shown(store)).toMatchObject({ state: 'done' })
        toast.dismiss()
        expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
      })

      it('still lets Undo bring the exited result back, with nothing sent', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store.getState().applyProgramStatusPaneRows([exitedAs('done')])
        toast.undo()
        expect(shown(store)).toMatchObject({ state: 'done' })
        toast.dismiss()
        expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
      })

      it('shows a different result and acknowledges nothing', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store.getState().applyProgramStatusPaneRows([exitedAs('error')])
        expect(shown(store)).toBeDefined()
        toast.dismiss()
        expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
      })
    })

    describe('the pending dismissal is its own operation, bound to the PTY', () => {
      const generation = (
        aggregate: ProgramStatusSummaryState,
        gen: number,
        liveness: ProgramStatusLiveness = 'live'
      ) => {
        const base = slot(aggregate, liveness)
        return { ...base, shown: { ...base.shown, generation: gen } }
      }
      const toastAt = (index: number) => undoToast.show.mock.calls.at(index)?.[1]

      it('follows the PTY to another pane, and acknowledges it there', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store
          .getState()
          .transferAgentPaneAuthority({ fromPaneKey: PANE, toPaneKey: OTHER, ptyId: 'pty1' })
        store
          .getState()
          .applyProgramStatusPaneRows([slotRow(null, PANE), slotRow(slot('done'), OTHER)])
        expect(selectComposedAgentStatusByPaneKey(store.getState())[OTHER]).toBeUndefined()
        toast.dismiss()
        expect(window.api.agentStatus.drop).toHaveBeenCalledTimes(1)
        expect(window.api.agentStatus.drop).toHaveBeenCalledWith(OTHER, ACK)
      })

      it('lets Undo restore the result on the pane the PTY moved to', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store
          .getState()
          .applyProgramStatusPaneRows([slotRow(null, PANE), slotRow(slot('done'), OTHER)])
        toast.undo()
        expect(selectComposedAgentStatusByPaneKey(store.getState())[OTHER]).toMatchObject({
          state: 'done'
        })
        toast.dismiss()
        expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
      })

      it('survives a retire and restore of its pane', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store.getState().retireAgentPaneAuthority(PANE)
        store.getState().restoreAgentPaneAuthority(PANE)
        store.getState().applyProgramStatusPaneRows([slotRow(slot('done'))])
        expect(shown(store)).toBeUndefined()
        toast.dismiss()
        expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, ACK)
      })

      it('survives the pane record being dropped and republished', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store.getState().dropAgentStatus(PANE, { paneRemoved: true })
        vi.mocked(window.api.agentStatus.drop).mockClear()
        store.getState().applyProgramStatusPaneRows([slotRow(slot('done'))])
        expect(shown(store)).toBeUndefined()
        toast.dismiss()
        expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, ACK)
      })

      it('waits out a closed pane: the ack leaves once the PTY shows the same result again', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store.getState().retireAgentPaneAuthority(PANE)
        toast.dismiss()
        expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
        store.getState().restoreAgentPaneAuthority(PANE)
        store.getState().applyProgramStatusPaneRows([slotRow(slot('done'))])
        expect(window.api.agentStatus.drop).toHaveBeenCalledTimes(1)
        expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, ACK)
      })

      it('is retired by a newer generation even while its pane is closed', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store.getState().retireAgentPaneAuthority(PANE)
        store.getState().applyProgramStatusPaneRows([slotRow(generation('done', 5))])
        store.getState().applyProgramStatusPaneRows([slotRow(generation('done', 6, 'exited'))])
        store.getState().restoreAgentPaneAuthority(PANE)
        store.getState().applyProgramStatusPaneRows([slotRow(generation('done', 6, 'exited'))])
        expect(shown(store)).toMatchObject({ state: 'done' })
        toast.dismiss()
        expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
      })

      it('ignores a stale row of an older revision', () => {
        const store = boardStore()
        const stale = slotRow(generation('done', 5))
        const toast = clearWithToast(store)
        store.getState().applyProgramStatusPaneRows([stale])
        expect(shown(store)).toBeUndefined()
        toast.dismiss()
        expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, ACK)
      })

      it('is retired by a new incarnation of the same PTY', () => {
        const store = boardStore()
        const toast = clearWithToast(store)
        store
          .getState()
          .applyProgramStatusPaneRows([slotRow({ ...slot('done'), incarnationId: 'inc-2' })])
        expect(shown(store)).toMatchObject({ state: 'done' })
        toast.dismiss()
        expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
      })

      describe('a newer clear of a later result', () => {
        function twoClears(store: TestStore) {
          const first = clearWithToast(store)
          store.getState().applyProgramStatusPaneRows([slotRow(generation('done', 5))])
          store.getState().applyProgramStatusPaneRows([slotRow(generation('done', 6, 'exited'))])
          expect(clearCompletedActivity([thread()])).toBe(true)
          return { first, second: toastAt(-1) }
        }

        it("is not undone by the older toast's Undo", () => {
          const store = boardStore()
          const { first, second } = twoClears(store)
          expect(shown(store)).toBeUndefined()
          first.undo()
          expect(shown(store)).toBeUndefined()
          second.onDismiss()
          expect(window.api.agentStatus.drop).toHaveBeenCalledTimes(1)
          expect(window.api.agentStatus.drop).toHaveBeenCalledWith(PANE, {
            incarnationId: 'inc-1',
            view: 'onExit',
            generation: 6
          })
        })

        it("is not committed by the older toast's close, and its own Undo still works", () => {
          const store = boardStore()
          const { first, second } = twoClears(store)
          first.dismiss()
          expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
          second.action.onClick()
          expect(shown(store)).toMatchObject({ state: 'done' })
          second.onDismiss()
          expect(window.api.agentStatus.drop).not.toHaveBeenCalled()
        })
      })
    })
  })
})

describe('a folder workspace composes like a git worktree', () => {
  it('a slot-only pane of a folder workspace is counted and carded', () => {
    const workspaceId = folderWorkspaceKey('folder-1')
    const tab: TerminalTab = {
      ...TAB,
      id: 'folder-tab',
      ptyId: 'pty-folder',
      worktreeId: workspaceId
    }
    const paneKey = makePaneKey('folder-tab', LEAF)
    const store = createTestStore()
    holder.store = store
    store.setState({
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          name: 'Docs workspace',
          folderPath: '/workspace/docs',
          connectionId: null,
          linkedTask: null,
          comment: '',
          isArchived: false,
          isUnread: false,
          isPinned: false,
          sortOrder: 0,
          lastActivityAt: NOW,
          createdAt: NOW,
          updatedAt: NOW
        }
      ],
      projectGroups: [
        {
          id: 'group-1',
          name: 'Documentation',
          parentPath: '/workspace',
          connectionId: null,
          parentGroupId: null,
          createdFrom: 'folder-scan',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: NOW,
          updatedAt: NOW
        }
      ],
      tabsByWorktree: { [workspaceId]: [tab] },
      terminalLayoutsByTabId: {
        'folder-tab': {
          root: { type: 'leaf', leafId: LEAF },
          activeLeafId: LEAF,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF]: 'pty-folder' }
        }
      },
      ptyIdsByTabId: { 'folder-tab': ['pty-folder'] }
    })
    expect(buildDashboardBucketCounts(store.getState(), NOW).working).toBe(0)
    store.getState().applyProgramStatusPaneRows([
      {
        programStatusOnly: true,
        paneKey,
        tabId: 'folder-tab',
        worktreeId: workspaceId,
        revision: 1,
        programStatus: slot('working')
      }
    ])
    expect(buildDashboardBucketCounts(store.getState(), NOW).working).toBe(1)
    const card = buildDashboardSnapshot(store.getState(), NOW).cards.find(
      (candidate) => candidate.paneKey === paneKey
    )
    expect(card).toMatchObject({
      worktreeId: workspaceId,
      dotState: 'working',
      statusExpiresAt: null
    })
  })
})
