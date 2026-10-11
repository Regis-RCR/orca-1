import { describe, expect, it } from 'vitest'
import { dashboardRowBucketProjection } from '@/components/dashboard/dashboard-row-bucket'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import {
  PROGRAM_STATUS_ENTRY_TABLE,
  programStatusEntryPair
} from '../../../shared/program-status/program-status-entry-table.test-support'
import {
  applyAgentPaneActivityFlags,
  type AgentPaneActivityFlags
} from './agent-pane-activity-flags'
import { agentRowDisplayDotState } from './agent-row-dot-state'
import { resolveWorktreeStatus } from './worktree-status'

function rowDot(entry: AgentStatusEntry): string {
  return agentRowDisplayDotState({ state: entry.state, entry })
}

function dashboardRow(entry: AgentStatusEntry) {
  return dashboardRowBucketProjection(
    {
      paneKey: entry.paneKey,
      entry,
      state: entry.state,
      startedAt: 1
    },
    { liveTurns: {}, retainedTurns: {}, acknowledgedTurnStartedAt: {} }
  )
}

/** The worktree card for one fresh pane: the per-entry fold, then the card's ranking. */
function worktreeCard(entry: AgentStatusEntry): string {
  const flags: AgentPaneActivityFlags = {
    hasPermission: false,
    hasLiveWorking: false,
    hasLiveMonitoring: false,
    hasFailed: false,
    hasInterrupted: false,
    hasUnconfirmed: false,
    hasLiveDone: false
  }
  applyAgentPaneActivityFlags(flags, entry)
  return resolveWorktreeStatus({
    tabs: [],
    browserTabs: [],
    ptyIdsByTabId: {},
    ...flags,
    hasRetainedDone: false
  })
}

describe('a composed program status entry reads like a hook entry of the same state and verdict', () => {
  it.each(PROGRAM_STATUS_ENTRY_TABLE)('aggregate $aggregate with root $root', (row) => {
    const { composed, hook } = programStatusEntryPair(row)
    expect(rowDot(composed)).toBe(rowDot(hook))
    expect(rowDot(composed)).toBe(row.rowDot)
    expect(dashboardRow(composed)).toEqual(dashboardRow(hook))
    expect(dashboardRow(composed).dotState).toBe(row.dashboardDot)
    expect(worktreeCard(composed)).toBe(worktreeCard(hook))
    expect(worktreeCard(composed)).toBe(row.worktreeCard)
  })
})
