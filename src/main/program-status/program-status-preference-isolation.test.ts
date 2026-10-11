import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { composeAgentStatusEntry } from '../../shared/program-status/compose-agent-status-entry'
import { programStatusPreferenceOf } from '../../shared/program-status/program-status-preference'
import { AgentHookServer, _internals, type HookListenerState } from '../agent-hooks/server'
import { buildBody, PANE, postHookEvent } from '../agent-hooks/server.test-fixtures'
import { createProgramStatusIngress } from './program-status-ingress'
import { createProgramStatusLocalIngest } from './program-status-local-ingest'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))

const PTY = 'pty-1'
const report = (body: string): string => `\x1b]7501;${body}\x07`

type Step =
  | { kind: 'hook'; payload: Record<string, unknown> }
  | { kind: 'osc9999'; state: 'working' | 'done' }
  | { kind: '7501'; body: string }
  | { kind: 'prefer'; value: boolean }

// One recorded turn reported by all three producers; the clock advances between every step.
const SEQUENCE: Step[] = [
  { kind: 'hook', payload: { hook_event_name: 'UserPromptSubmit', prompt: 'review the change' } },
  { kind: '7501', body: 'state=working' },
  { kind: 'osc9999', state: 'working' },
  { kind: 'hook', payload: { hook_event_name: 'PreToolUse', tool_name: 'Read' } },
  { kind: '7501', body: 'state=blocked:kind=permission' },
  { kind: 'hook', payload: { hook_event_name: 'Stop' } },
  { kind: '7501', body: 'state=done' },
  { kind: 'osc9999', state: 'done' }
]

type Variant = {
  preferred: boolean
  /** Inserted after this many steps of the sequence. */
  insertAt?: number
  insert?: Step[]
  without7501?: boolean
}

/** Normalization caches, the lead and session-owner registries and the row tables. */
function cloneableFields(state: HookListenerState): Record<string, unknown> {
  const fields = Object.fromEntries(
    Object.entries(state).flatMap(([key, value]) => {
      try {
        const plain = value instanceof Map || value instanceof Set ? [...value.entries()] : value
        return [[key, structuredClone(plain)]]
      } catch {
        return []
      }
    })
  )
  return fields
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** Plain JSON with each server's random ids (store epoch, authority id) numbered by first use. */
function normalizeIds(value: unknown): unknown {
  const seen = new Map<string, string>()
  const text = JSON.stringify(value, (_key, entry: unknown) =>
    entry instanceof Map || entry instanceof Set ? [...entry] : entry
  )
  return JSON.parse(
    text.replace(
      UUID,
      (id) => seen.get(id) ?? (seen.set(id, `id-${seen.size}`), `id-${seen.size - 1}`)
    )
  )
}

async function run(variant: Variant) {
  _internals.resetCachesForTests()
  vi.setSystemTime(2_000_000)
  const server = new AgentHookServer()
  await server.start({ env: 'production' })
  try {
    const ingress = createProgramStatusIngress({
      sink: {
        report: (target, write) => server.ingestProgramStatusReport({ ...target, write }),
        lifecycle: (paneKey, write) => server.applyProgramStatusLifecycle(paneKey, write),
        rekey: (from, to, identity, current) =>
          server.rekeyProgramStatus(from, to, identity, current),
        forget: (paneKey, identity, options) =>
          server.forgetProgramStatus(paneKey, identity, options)
      },
      resolveTarget: () => ({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }),
      resolvePaneKey: (paneKey) => server.resolveProgramStatusPaneKey(paneKey),
      now: Date.now
    })
    const local = createProgramStatusLocalIngest(ingress)
    local.begin(PTY, 'inc-1')
    const settings = { agentProgramStatusPreferred: variant.preferred }
    // Why inserted steps share the instant before them: the base sequence keeps its own times.
    const steps = SEQUENCE.map((step) => ({ step, tick: true }))
    const inserted = (variant.insert ?? []).map((step) => ({ step, tick: false }))
    steps.splice(variant.insertAt ?? steps.length, 0, ...inserted)
    for (const { step, tick } of steps) {
      if (tick) {
        vi.setSystemTime(Date.now() + 1_000)
      }
      if (step.kind === 'hook') {
        const response = await postHookEvent(server, buildBody(step.payload), '/hook/claude')
        expect(response.status).toBe(204)
      } else if (step.kind === 'osc9999') {
        server.ingestTerminalStatus({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          connectionId: null,
          payload: { state: step.state, prompt: 'review the change', agentType: 'claude' }
        })
      } else if (step.kind === '7501') {
        if (!variant.without7501) {
          local.observe(PTY, report(step.body), Date.now())
        }
      } else {
        settings.agentProgramStatusPreferred = step.value
      }
    }
    const state = server._getStateForTests()
    const hookSide = normalizeIds({
      snapshot: server.getStatusSnapshot(),
      changes: server.getStatusChangeSnapshot(),
      canonical: server.getCanonicalStatusSnapshot(),
      providerSessions: server.getProviderSessionIdentities(),
      listener: cloneableFields(state),
      // Why by name: these row tables are map-like wrappers structuredClone refuses whole.
      rows: [...state.lastStatusByPaneKey.entries()],
      claudeLead: [...state.claudeLeadStateByPaneKey.entries()],
      claudeOwners: [...state.claudeSessionOwnerByPaneKey.entries()]
    })
    const slotRow = server.getProgramStatusSnapshot().find((row) => row.paneKey === PANE)
    const slot = slotRow?.programStatus
      ? { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1', slot: slotRow.programStatus }
      : undefined
    const composed = composeAgentStatusEntry(
      server.getStatusSnapshot().find((row) => row.paneKey === PANE),
      slot,
      programStatusPreferenceOf(settings)
    )
    return { hookSide, slots: structuredClone(server.getProgramStatusSnapshot()), composed }
  } finally {
    server.stop()
  }
}

beforeEach(() => {
  // Only the wall clock is faked, so the hook server's real sockets keep working.
  vi.useFakeTimers({ toFake: ['Date'] })
})
afterEach(() => {
  vi.useRealTimers()
})

describe('the OSC 7501 preference leaves the hook pipeline untouched (design 8.2)', () => {
  it('runs the same hook, OSC 9999 and OSC 7501 sequence to the same hook-side state in each mode', async () => {
    const hooksFirst = await run({ preferred: false })
    const preferred = await run({ preferred: true })
    const without7501 = await run({ preferred: false, without7501: true })

    expect(preferred.hookSide).toEqual(hooksFirst.hookSide)
    expect(without7501.hookSide).toEqual(hooksFirst.hookSide)
    // The slot table is the only difference, and the mode never changes what it holds.
    expect(preferred.slots).toEqual(hooksFirst.slots)
    expect(hooksFirst.slots).toHaveLength(1)
    expect(without7501.slots).toEqual([])
    // Only the read-time composition reads the setting.
    expect(hooksFirst.composed).toMatchObject({ state: 'done', paneKey: PANE })
    expect(hooksFirst.composed).not.toHaveProperty('programStatusLive')
    expect(preferred.composed).toMatchObject({ state: 'done', programStatusLive: true })
  })

  const preferOn: Step[] = [{ kind: 'prefer', value: true }]
  const preferOffThenOn: Step[] = [
    { kind: 'prefer', value: false },
    { kind: 'prefer', value: true }
  ]
  const clearReport: Step[] = [{ kind: '7501', body: 'clear' }]
  it.each([
    ['toggling the setting on', preferOn],
    ['toggling the setting off and on', preferOffThenOn],
    ['a clear report', clearReport]
  ])('changes no hook-side value when %s lands mid-sequence', async (_name, insert) => {
    const baseline = await run({ preferred: false })
    for (const insertAt of [1, 4, 6]) {
      const varied = await run({ preferred: false, insertAt, insert })
      expect(varied.hookSide).toEqual(baseline.hookSide)
    }
  })
})
