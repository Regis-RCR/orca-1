import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentVerdictDisplayMark } from '../agent-main-agent-verdict'
import type { AgentStatusObservationOrigin } from '../agent-status-observation'
import {
  normalizeMainAgentStatusField,
  type AgentStatusEntry,
  type AgentStatusState
} from '../agent-status-types'
import {
  composeAgentStatusEntry,
  programStatusEntryFromSlot,
  type ProgramStatusSlotAtPane
} from './compose-agent-status-entry'
import { PROGRAM_STATUS_ENTRY_TABLE } from './program-status-entry-table.test-support'
import type {
  ProgramStatusLiveness,
  ProgramStatusSummary,
  ProgramStatusSummaryState
} from './program-status-slot'

const PANE = { paneKey: 'tab-1:leaf-1', tabId: 'tab-1', worktreeId: 'wt-1' }

function slotAt(
  summary: ProgramStatusSummary,
  liveness: ProgramStatusLiveness = 'live',
  times = { changedAt: 2000, rootChangedAt: 1500, livenessChangedAt: 1800 }
): ProgramStatusSlotAtPane {
  return {
    ...PANE,
    slot: {
      ptyId: 'pty-1',
      incarnationId: 'inc-1',
      reportSeq: 1,
      liveness,
      livenessChangedAt: times.livenessChangedAt,
      view: liveness === 'exited' ? 'onExit' : 'now',
      shown: {
        summary,
        generation: 1,
        changedAt: times.changedAt,
        rootChangedAt: summary.root === null ? null : times.rootChangedAt
      }
    }
  }
}

const summary = (
  aggregate: ProgramStatusSummaryState,
  root: ProgramStatusSummaryState | null,
  childError = false
): ProgramStatusSummary => ({ aggregate, root, childError })

function hookEntry(
  state: AgentStatusState,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: 'from the hook',
    updatedAt: 1000,
    stateStartedAt: 1000,
    paneKey: PANE.paneKey,
    stateHistory: [],
    agentType: 'claude',
    ...overrides
  }
}

function hookWithOrigin(origin: AgentStatusObservationOrigin): AgentStatusEntry {
  return hookEntry('working', {
    observation: { origin, authorityId: 'a', incarnation: 1, revision: 1, observedAt: 1000 }
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('programStatusEntryFromSlot: state from the aggregate, verdict from the root', () => {
  it.each(PROGRAM_STATUS_ENTRY_TABLE)(
    'maps aggregate $aggregate with root $root',
    ({ aggregate, root, state, outcome }) => {
      const entry = programStatusEntryFromSlot(slotAt(summary(aggregate, root)))
      expect(entry.state).toBe(state)
      expect(entry.mainAgent?.outcome ?? null).toBe(outcome)
      expect(entry.programStatusResting).toBeUndefined()
      expect(entry.sessionBoundary).toBeUndefined()
      const handBuilt = hookEntry(state, entry.mainAgent ? { mainAgent: entry.mainAgent } : {})
      expect(agentVerdictDisplayMark(entry)).toBe(agentVerdictDisplayMark(handBuilt))
      expect(agentVerdictDisplayMark(entry)).toBe(outcome === 'failure' ? 'failed' : null)
    }
  )

  it('maps idle to a resting session-boundary done, fresh or old', () => {
    for (const changedAt of [2000, 2000 - 31 * 60_000]) {
      const entry = programStatusEntryFromSlot(
        slotAt(summary('idle', 'idle'), 'unverifiable', {
          changedAt,
          rootChangedAt: changedAt,
          livenessChangedAt: changedAt
        })
      )
      expect(entry).toMatchObject({
        state: 'done',
        sessionBoundary: true,
        programStatusResting: true
      })
      expect(entry.mainAgent).toBeUndefined()
      expect(agentVerdictDisplayMark(entry)).toBeNull()
    }
  })

  it('takes mainAgent from the root alone, through the existing normalizer (codec chain)', () => {
    const chain: [ProgramStatusSummaryState, string | undefined][] = [
      ['done', 'success'],
      ['error', 'failure'],
      ['idle', undefined],
      ['working', undefined]
    ]
    for (const [root, outcome] of chain) {
      const entry = programStatusEntryFromSlot(slotAt(summary('working', root)))
      expect(entry.mainAgent?.outcome).toBe(outcome)
      if (entry.mainAgent) {
        expect(normalizeMainAgentStatusField(entry.mainAgent)).toEqual(entry.mainAgent)
        expect(entry.mainAgent).toEqual({ state: 'done', outcome, stateStartedAt: 1500 })
      }
    }
  })

  it('keeps a child error out of the verdict: root idle, child error gives done without one', () => {
    const entry = programStatusEntryFromSlot(slotAt(summary('done', 'idle', true)))
    expect(entry.state).toBe('done')
    expect(entry.mainAgent).toBeUndefined()
  })
})

describe('programStatusEntryFromSlot: fields', () => {
  it('builds a display-only entry with only the allowed fields', () => {
    const entry = programStatusEntryFromSlot(slotAt(summary('done', 'done')))
    expect(entry).toEqual({
      ...PANE,
      state: 'done',
      prompt: '',
      updatedAt: 2000,
      stateStartedAt: 2000,
      evidenceObservedAt: 2000,
      stateHistory: [],
      mainAgent: { state: 'done', outcome: 'success', stateStartedAt: 1500 },
      programStatusLive: true
    })
  })

  it('dates evidence at the last verified instant once the producer is not live', () => {
    for (const liveness of ['unverifiable', 'exited'] as const) {
      const entry = programStatusEntryFromSlot(slotAt(summary('working', 'working'), liveness))
      expect(entry.evidenceObservedAt).toBe(1800)
      expect(entry.updatedAt).toBe(2000)
      expect(entry.programStatusLive).toBeUndefined()
    }
  })

  it('omits an absent address field', () => {
    const { tabId: _tabId, worktreeId: _worktreeId, ...bare } = slotAt(summary('done', 'done'))
    const entry = programStatusEntryFromSlot(bare)
    expect('tabId' in entry).toBe(false)
    expect('worktreeId' in entry).toBe(false)
  })
})

describe('composeAgentStatusEntry: hook or slot', () => {
  const slot = slotAt(summary('done', 'done'))

  it('returns the hook unchanged, identity included, when there is no slot', () => {
    const hook = hookEntry('working')
    expect(composeAgentStatusEntry(hook, undefined, 'hooks-first')).toBe(hook)
    expect(composeAgentStatusEntry(hook, undefined, 'program-status-first')).toBe(hook)
    expect(composeAgentStatusEntry(undefined, undefined, 'hooks-first')).toBeUndefined()
  })

  it('prefers the slot whatever the hook when 7501 is preferred', () => {
    const composed = composeAgentStatusEntry(hookEntry('blocked'), slot, 'program-status-first')
    expect(composed).toEqual(programStatusEntryFromSlot(slot))
  })

  it('shows the slot under hooks-first when the hook row is absent', () => {
    expect(composeAgentStatusEntry(undefined, slot, 'hooks-first')).toEqual(
      programStatusEntryFromSlot(slot)
    )
  })

  it.each(['launch', 'process'] as const)('yields a %s seed to the slot', (origin) => {
    expect(composeAgentStatusEntry(hookWithOrigin(origin), slot, 'hooks-first')?.state).toBe('done')
  })

  it('yields a restoredUnconfirmed hook row to the slot', () => {
    const hook = hookEntry('working', { restoredUnconfirmed: true })
    expect(composeAgentStatusEntry(hook, slot, 'hooks-first')?.state).toBe('done')
  })

  it.each(['hook', 'osc', 'title', 'orchestration', 'structured'] as const)(
    'keeps a %s hook row ahead of the slot',
    (origin) => {
      const hook = hookWithOrigin(origin)
      expect(composeAgentStatusEntry(hook, slot, 'hooks-first')).toBe(hook)
    }
  )

  it('keeps a hook row without an observation facet ahead of the slot', () => {
    const hook = hookEntry('working', { restoredUnconfirmed: false })
    expect(composeAgentStatusEntry(hook, slot, 'hooks-first')).toBe(hook)
  })

  it('composes the host payload shape too (structural hook input)', () => {
    const payload = { state: 'working' as const, paneKey: PANE.paneKey, restoredUnconfirmed: true }
    expect(composeAgentStatusEntry(payload, slot, 'hooks-first')).not.toBe(payload)
    expect(
      composeAgentStatusEntry({ ...payload, restoredUnconfirmed: false }, slot, 'hooks-first')
    ).toMatchObject({ state: 'working' })
  })

  it('reads no clock', () => {
    const fail = () => {
      throw new Error('read a clock')
    }
    vi.spyOn(Date, 'now').mockImplementation(fail)
    vi.spyOn(performance, 'now').mockImplementation(fail)
    expect(() => composeAgentStatusEntry(hookEntry('done'), slot, 'hooks-first')).not.toThrow()
    expect(() => composeAgentStatusEntry(undefined, slot, 'hooks-first')).not.toThrow()
    expect(() =>
      composeAgentStatusEntry(hookEntry('done'), slot, 'program-status-first')
    ).not.toThrow()
  })
})

describe('composeAgentStatusEntry: precedence never depends on observation recency', () => {
  it('shows the hook row for one turn reported by both producers, in both orders', () => {
    for (const [hookAt, slotAt7501] of [
      [1000, 1001],
      [1001, 1000]
    ] as const) {
      const hook = hookEntry('done', {
        updatedAt: hookAt,
        stateStartedAt: hookAt,
        evidenceObservedAt: hookAt
      })
      const slot = slotAt(summary('done', 'done'), 'live', {
        changedAt: slotAt7501,
        rootChangedAt: slotAt7501,
        livenessChangedAt: slotAt7501
      })
      expect(composeAgentStatusEntry(hook, slot, 'hooks-first')).toBe(hook)
    }
  })

  it('gives the same winner whatever the clock steps between the two producers', () => {
    let seed = 7
    const random = (): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed / 2_147_483_648
    }
    const states: AgentStatusState[] = ['working', 'blocked', 'waiting', 'done']
    const aggregates: ProgramStatusSummaryState[] = [
      'working',
      'blocked',
      'question',
      'done',
      'error',
      'idle'
    ]
    const origins: AgentStatusObservationOrigin[] = ['hook', 'osc', 'launch', 'process', 'title']
    for (let round = 0; round < 300; round += 1) {
      const origin = origins[Math.floor(random() * origins.length)] ?? 'hook'
      const state = states[Math.floor(random() * states.length)] ?? 'done'
      const aggregate = aggregates[Math.floor(random() * aggregates.length)] ?? 'done'
      const winners = new Set<string>()
      for (const step of [1, 1000, 31 * 60_000, -1, -31 * 60_000]) {
        const base = Math.floor(random() * 1e9)
        const hook = {
          ...hookWithOrigin(origin),
          state,
          updatedAt: base,
          stateStartedAt: base,
          evidenceObservedAt: base
        }
        const slot = slotAt(summary(aggregate, aggregate), 'live', {
          changedAt: base + step,
          rootChangedAt: base + step,
          livenessChangedAt: base + step
        })
        const composed = composeAgentStatusEntry(hook, slot, 'hooks-first')
        winners.add(composed === hook ? 'hook' : 'slot')
      }
      expect(winners.size).toBe(1)
      expect([...winners][0]).toBe(origin === 'launch' || origin === 'process' ? 'slot' : 'hook')
    }
  })
})
