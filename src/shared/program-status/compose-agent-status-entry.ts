import type { AgentStatusObservationOrigin } from '../agent-status-observation'
import type { AgentStatusEntry, AgentStatusState } from '../agent-status-types'
import type { AgentMainAgentStatus } from '../main-agent-status'
import type {
  ProgramStatusSlot,
  ProgramStatusSummaryState,
  ProgramStatusView
} from './program-status-slot'

/** `program-status-first` is the user's setting that prefers OSC 7501 over hooks. */
export type ProgramStatusPreference = 'hooks-first' | 'program-status-first'

/** A visible slot with the pane it is attributed to. */
export type ProgramStatusSlotAtPane = {
  paneKey: string
  tabId?: string
  worktreeId?: string
  slot: ProgramStatusSlot
}

/** Display-only; built at read time, never serialized, never fed to the live-entry builder. */
export type ProgramStatusComposedEntry = AgentStatusEntry & {
  programStatusResting?: true
  programStatusLive?: true
}

/** The renderer's AgentStatusEntry and the host's IPC payload both fit. */
export type ComposableHookEntry = {
  observation?: { origin: AgentStatusObservationOrigin }
  restoredUnconfirmed?: boolean
}

const STATE_OF: Record<ProgramStatusSummaryState, AgentStatusState> = {
  working: 'working',
  question: 'waiting',
  blocked: 'blocked',
  done: 'done',
  error: 'done',
  idle: 'done'
}

/** From the root alone, whatever the aggregate: only the root can fail the main agent. */
function mainAgentOf(view: ProgramStatusView): AgentMainAgentStatus | undefined {
  const { root } = view.summary
  if (root !== 'done' && root !== 'error') {
    return undefined
  }
  return {
    state: 'done',
    outcome: root === 'done' ? 'success' : 'failure',
    stateStartedAt: view.rootChangedAt ?? view.changedAt
  }
}

export function programStatusEntryFromSlot({
  paneKey,
  tabId,
  worktreeId,
  slot
}: ProgramStatusSlotAtPane): ProgramStatusComposedEntry {
  const { aggregate } = slot.shown.summary
  const live = slot.liveness === 'live'
  const mainAgent = mainAgentOf(slot.shown)
  return {
    paneKey,
    ...(tabId !== undefined ? { tabId } : {}),
    ...(worktreeId !== undefined ? { worktreeId } : {}),
    state: STATE_OF[aggregate],
    prompt: '',
    updatedAt: slot.shown.changedAt,
    stateStartedAt: slot.shown.changedAt,
    // Why: past liveness, the last instant the host could verify the producer is what decays.
    evidenceObservedAt: live ? slot.shown.changedAt : slot.livenessChangedAt,
    stateHistory: [],
    ...(mainAgent ? { mainAgent } : {}),
    ...(aggregate === 'idle' ? { sessionBoundary: true, programStatusResting: true as const } : {}),
    ...(live ? { programStatusLive: true as const } : {})
  }
}

/** Only properties of the hook row itself, never a timestamp: precedence cannot follow recency. */
function hookIsValid<H extends ComposableHookEntry>(hook: H | undefined): hook is H {
  const origin = hook?.observation?.origin
  return (
    hook !== undefined &&
    origin !== 'launch' &&
    origin !== 'process' &&
    hook.restoredUnconfirmed !== true
  )
}

/** Presentation policy: pure, clock-free, and the identity when there is no visible slot. */
export function composeAgentStatusEntry<H extends ComposableHookEntry>(
  hook: H | undefined,
  slot: ProgramStatusSlotAtPane | undefined,
  preference: ProgramStatusPreference
): H | ProgramStatusComposedEntry | undefined {
  if (!slot) {
    return hook
  }
  if (preference === 'hooks-first' && hookIsValid(hook)) {
    return hook
  }
  return programStatusEntryFromSlot(slot)
}
