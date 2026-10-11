import { describe, expect, it } from 'vitest'
import {
  PROGRAM_STATUS_ENTRY_TABLE,
  programStatusEntryPair
} from '../../shared/program-status/program-status-entry-table.test-support'
import { mapExplicitAgentStateToRuntimeTerminalStatus } from './runtime-worktree-status-projection'

describe('worktree ps reads a composed program status entry like a hook entry of the same state', () => {
  it.each(PROGRAM_STATUS_ENTRY_TABLE)('aggregate $aggregate with root $root', (row) => {
    const { composed, hook } = programStatusEntryPair(row)
    expect(mapExplicitAgentStateToRuntimeTerminalStatus(composed.state)).toBe(
      mapExplicitAgentStateToRuntimeTerminalStatus(hook.state)
    )
    expect(mapExplicitAgentStateToRuntimeTerminalStatus(composed.state)).toBe(row.worktreePs)
  })
})
