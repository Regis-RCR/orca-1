import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { composeAgentStatusEntry } from '../../../../shared/program-status/compose-agent-status-entry'
import { programStatusMirrorEntry } from '../../../../shared/program-status/program-status-expiry'
import { isProgramStatusMirrorRecordVisible } from '../../../../shared/program-status/program-status-pane-payload'
import type { AppState } from '../types'

/** The composition inputs every projected state on the composition path must carry. */
export type AgentStatusCompositionState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'programStatusByPaneKey'
  | 'programStatusPreferred'
  | 'programStatusEpoch'
>

type Mirror = AppState['programStatusByPaneKey'] | undefined
type HookMap = Record<string, AgentStatusEntry>

let composedMemo: {
  hook: HookMap
  mirror: Mirror
  preferred: boolean
  composed: HookMap
} | null = null

/** The hook map with each visible slot composed in; the hook map itself when none is visible. */
export function composeAgentStatusMap(
  hook: HookMap,
  mirror: Mirror,
  preferred: boolean | undefined
): HookMap {
  const isPreferred = preferred === true
  if (
    composedMemo &&
    composedMemo.hook === hook &&
    composedMemo.mirror === mirror &&
    composedMemo.preferred === isPreferred
  ) {
    return composedMemo.composed
  }
  let composed = hook
  for (const [paneKey, record] of Object.entries(mirror ?? {})) {
    if (!isProgramStatusMirrorRecordVisible(record)) {
      continue
    }
    const winner = composeAgentStatusEntry(
      hook[paneKey],
      { paneKey, slot: record.slot },
      isPreferred ? 'program-status-first' : 'hooks-first'
    )
    if (winner === hook[paneKey]) {
      continue
    }
    composed = composed === hook ? { ...hook } : composed
    composed[paneKey] = programStatusMirrorEntry(paneKey, record)
  }
  composedMemo = { hook, mirror, preferred: isPreferred, composed }
  return composed
}

export function selectComposedAgentStatusByPaneKey(
  state: Pick<AppState, 'agentStatusByPaneKey'> &
    Partial<Pick<AppState, 'programStatusByPaneKey' | 'programStatusPreferred'>>
): HookMap {
  return composeAgentStatusMap(
    state.agentStatusByPaneKey,
    state.programStatusByPaneKey,
    state.programStatusPreferred
  )
}

type CompositionToken = Readonly<{ agentStatusEpoch: number; programStatusEpoch: number }>
let tokenMemo: CompositionToken | null = null

/**
 * The freshness key of every cache that used to key on `agentStatusEpoch`: that epoch itself
 * until a slot ever composed, then one frozen object per distinct pair, so `===` stays exact.
 */
export function agentStatusCompositionToken(
  state: Pick<AppState, 'agentStatusEpoch'> & Partial<Pick<AppState, 'programStatusEpoch'>>
): number | CompositionToken {
  const programStatusEpoch = state.programStatusEpoch ?? 0
  if (programStatusEpoch === 0) {
    return state.agentStatusEpoch
  }
  if (
    tokenMemo?.agentStatusEpoch !== state.agentStatusEpoch ||
    tokenMemo.programStatusEpoch !== programStatusEpoch
  ) {
    tokenMemo = Object.freeze({ agentStatusEpoch: state.agentStatusEpoch, programStatusEpoch })
  }
  return tokenMemo
}
