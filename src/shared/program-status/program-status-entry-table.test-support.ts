import type { AgentStatusEntry, AgentStatusState } from '../agent-status-types'
import {
  programStatusEntryFromSlot,
  type ProgramStatusComposedEntry
} from './compose-agent-status-entry'
import type { ProgramStatusSummaryState } from './program-status-slot'

/**
 * One summary short of `idle`, with what each existing reader shows for a fresh hook entry of the
 * same state and verdict. `idle` is left out: it reaches its row state through a marker only.
 */
export type ProgramStatusEntryTableRow = {
  aggregate: ProgramStatusSummaryState
  root: ProgramStatusSummaryState | null
  state: AgentStatusState
  outcome: 'success' | 'failure' | null
  rowDot: string
  dashboardDot: string
  worktreeCard: string
  worktreePs: string
}

type Columns = [
  ProgramStatusSummaryState,
  ProgramStatusSummaryState | null,
  AgentStatusState,
  'success' | 'failure' | null,
  string,
  string,
  string,
  string
]

// [aggregate, root, state, outcome, row dot, dashboard dot, worktree card, worktree ps]
const COLUMNS: Columns[] = [
  ['working', 'working', 'working', null, 'working', 'working', 'working', 'working'],
  ['working', 'idle', 'working', null, 'working', 'working', 'working', 'working'],
  ['working', null, 'working', null, 'working', 'working', 'working', 'working'],
  ['working', 'done', 'working', 'success', 'working', 'working', 'working', 'working'],
  ['working', 'error', 'working', 'failure', 'failed', 'working', 'failed', 'working'],
  ['question', 'question', 'waiting', null, 'waiting', 'waiting', 'permission', 'permission'],
  ['question', 'done', 'waiting', 'success', 'waiting', 'waiting', 'permission', 'permission'],
  ['blocked', 'blocked', 'blocked', null, 'blocked', 'blocked', 'permission', 'permission'],
  ['blocked', 'done', 'blocked', 'success', 'blocked', 'blocked', 'permission', 'permission'],
  ['question', 'error', 'waiting', 'failure', 'failed', 'waiting', 'permission', 'permission'],
  ['blocked', 'error', 'blocked', 'failure', 'failed', 'blocked', 'permission', 'permission'],
  ['done', 'done', 'done', 'success', 'done', 'done', 'done', 'idle'],
  ['error', 'error', 'done', 'failure', 'failed', 'done', 'failed', 'idle'],
  ['done', null, 'done', null, 'done', 'done', 'done', 'idle'],
  ['done', 'idle', 'done', null, 'done', 'done', 'done', 'idle']
]

export const PROGRAM_STATUS_ENTRY_TABLE: readonly ProgramStatusEntryTableRow[] = COLUMNS.map(
  ([aggregate, root, state, outcome, rowDot, dashboardDot, worktreeCard, worktreePs]) => ({
    aggregate,
    root,
    state,
    outcome,
    rowDot,
    dashboardDot,
    worktreeCard,
    worktreePs
  })
)

/** The composed entry of a live slot, and a hook entry built from the row's state and verdict. */
export function programStatusEntryPair(row: ProgramStatusEntryTableRow): {
  composed: ProgramStatusComposedEntry
  hook: AgentStatusEntry
} {
  const composed = programStatusEntryFromSlot({
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    slot: {
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      reportSeq: 1,
      liveness: 'live',
      livenessChangedAt: 1800,
      view: 'now',
      shown: {
        summary: { aggregate: row.aggregate, root: row.root, childError: false },
        generation: 1,
        changedAt: 2000,
        rootChangedAt: row.root === null ? null : 1500
      }
    }
  })
  const hook: AgentStatusEntry = {
    paneKey: composed.paneKey,
    state: row.state,
    prompt: 'from the hook',
    updatedAt: composed.updatedAt,
    stateStartedAt: composed.stateStartedAt,
    stateHistory: [],
    agentType: 'claude',
    ...(row.outcome
      ? { mainAgent: { state: 'done', outcome: row.outcome, stateStartedAt: 1500 } }
      : {})
  }
  return { composed, hook }
}
