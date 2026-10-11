/**
 * The captured `claude-code` 2.1.295 transcripts (`runtime/__fixtures__/claude-program-status-*`)
 * replayed through the local PTY owner's ingest: the real bytes, read in PTY-sized chunks, end in
 * the hook server's slot and in what every display reader composes from it.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  composeAgentStatusEntry,
  type ProgramStatusComposedEntry
} from '../../shared/program-status/compose-agent-status-entry'
import type { ProgramStatusSummaryState } from '../../shared/program-status/program-status-slot'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from '../agent-hooks/server'
import { LEAF_1 } from '../agent-hooks/server.test-fixtures'
import { createProgramStatusIngress } from './program-status-ingress'
import { createProgramStatusLocalIngest } from './program-status-local-ingest'

const PTY = 'pty-1'
const PANE = makePaneKey('tab-1', LEAF_1)
const READ_SIZE = 64

type Scenario = 'startup' | 'turn' | 'permission' | 'question' | 'interrupt' | 'subagent'

function transcript(scenario: Scenario): string {
  const name = `claude-program-status-2-1-295-${scenario}.txt`
  return readFileSync(join(__dirname, '..', 'runtime', '__fixtures__', name), 'utf8')
}

function replayLocally(text: string) {
  const server = new AgentHookServer()
  const shown: (ProgramStatusSummaryState | null)[] = []
  server.setProgramStatusListener((row) => {
    const aggregate = row.programStatus?.shown.summary.aggregate ?? null
    if (shown.at(-1) !== aggregate) {
      shown.push(aggregate)
    }
  })
  let clock = 1_000
  const ingress = createProgramStatusIngress({
    sink: {
      report: (target, write) => server.ingestProgramStatusReport({ ...target, write }),
      lifecycle: (paneKey, write) => server.applyProgramStatusLifecycle(paneKey, write),
      rekey: (from, to, identity, current) =>
        server.rekeyProgramStatus(from, to, identity, current),
      forget: (paneKey, identity, options) => server.forgetProgramStatus(paneKey, identity, options)
    },
    resolveTarget: () => ({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }),
    resolvePaneKey: (paneKey) => server.resolveProgramStatusPaneKey(paneKey),
    now: () => clock
  })
  // Reads a second apart, so the emission budget never coalesces two real transitions.
  const local = createProgramStatusLocalIngest(ingress, { monotonicNow: () => clock })
  local.begin(PTY, 'inc-1')
  for (let offset = 0; offset < text.length; offset += READ_SIZE) {
    clock += 1_000
    local.observe(PTY, text.slice(offset, offset + READ_SIZE), clock)
  }
  const composed = (): ProgramStatusComposedEntry | undefined => {
    const row = server.getProgramStatusSnapshot().find((entry) => entry.paneKey === PANE)
    const slot = row?.programStatus
      ? { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', slot: row.programStatus }
      : undefined
    return composeAgentStatusEntry<ProgramStatusComposedEntry>(undefined, slot, 'hooks-first')
  }
  return { shown, composed, exit: () => local.exit(PTY, true) }
}

describe('captured agent transcripts through the local ingest', () => {
  const cases: [Scenario, (ProgramStatusSummaryState | null)[], string | undefined][] = [
    ['startup', ['idle'], 'done'],
    ['turn', ['idle', 'working', 'done'], 'done'],
    ['permission', ['idle', 'working', 'blocked', 'working', 'done'], 'done'],
    ['question', ['idle', 'working', 'question', 'working', 'done'], 'done'],
    ['interrupt', ['idle', 'working', 'idle'], 'done'],
    ['subagent', ['idle', 'working', 'done', null], undefined]
  ]

  it.each(cases)('%s: the slot shows each real transition', (scenario, transitions, state) => {
    const { shown, composed } = replayLocally(transcript(scenario))
    expect(shown).toEqual(transitions)
    expect(composed()?.state).toBe(state)
    if (state !== undefined) {
      expect(composed()).toMatchObject({ paneKey: PANE, programStatusLive: true })
    }
  })

  it('an interrupted turn rests idle, the way a fresh session does', () => {
    const { composed } = replayLocally(transcript('interrupt'))
    expect(composed()).toMatchObject({ programStatusResting: true, sessionBoundary: true })
  })

  it.each(['turn', 'permission', 'question'] as const)(
    '%s: a certified exit keeps the finished turn on the open pane',
    (scenario) => {
      const run = replayLocally(transcript(scenario))
      run.exit()
      expect(run.composed()).toMatchObject({ state: 'done', mainAgent: { outcome: 'success' } })
      expect(run.composed()?.programStatusLive).toBeUndefined()
    }
  )

  it.each(['startup', 'interrupt'] as const)(
    '%s: a certified exit drops an idle slot, which says nothing past the process',
    (scenario) => {
      const run = replayLocally(transcript(scenario))
      run.exit()
      expect(run.composed()).toBeUndefined()
    }
  )

  it('subagent: the exit-time root clears leave no slot before the exit is even seen', () => {
    const run = replayLocally(transcript('subagent'))
    expect(run.composed()).toBeUndefined()
    run.exit()
    expect(run.composed()).toBeUndefined()
  })
})
