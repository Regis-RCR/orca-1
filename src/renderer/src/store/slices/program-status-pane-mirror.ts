import {
  isProgramStatusMirrorRecordVisible,
  type ProgramStatusMirrorRecord,
  type ProgramStatusPaneIpcPayload
} from '../../../../shared/program-status/program-status-pane-payload'
import type { AppState } from '../types'
import type { AgentStatusRuntime } from './agent-status-runtime'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import {
  getTabIdFromPaneKey,
  isRecentlyClosedAgentStatusTab
} from './agent-status-pane-key-tab-binding'

// Why the server's bound: the mirror never holds more slots than main does.
const PROGRAM_STATUS_MIRROR_BOUND = 500

type MirrorState = Pick<
  AppState,
  | 'programStatusByPaneKey'
  | 'programStatusClosedPaneKeys'
  | 'programStatusPreferred'
  | 'programStatusEpoch'
  | 'recentlyClosedAgentStatusTabIds'
>
type MirrorPatch = Partial<MirrorState>

function hasVisibleProgramStatus(records: Record<string, ProgramStatusMirrorRecord>): boolean {
  return Object.values(records).some((record) => isProgramStatusMirrorRecordVisible(record))
}

function evictOldestTombstones(records: Record<string, ProgramStatusMirrorRecord>): void {
  let excess = Object.keys(records).length - PROGRAM_STATUS_MIRROR_BOUND * 2
  for (const [paneKey, record] of Object.entries(records)) {
    if (excess <= 0) {
      return
    }
    if (record.slot === null) {
      delete records[paneKey]
      excess -= 1
    }
  }
}

/** A store update that changes nothing must hand back the same state, or subscribers wake. */
export function programStatusPatchOrSame<S extends object>(
  s: S,
  patch: MirrorPatch
): S | MirrorPatch {
  return Object.keys(patch).length > 0 ? patch : s
}

/** Max-revision per pane; a refused row leaves the record object, and so the mirror, untouched. */
export function programStatusRowsPatch(
  s: MirrorState,
  rows: readonly ProgramStatusPaneIpcPayload[]
): MirrorPatch {
  let next = s.programStatusByPaneKey
  let changedComposition = false
  for (const { paneKey, tabId, worktreeId, revision, programStatus } of rows) {
    const prev = next[paneKey]
    const closedTab = isRecentlyClosedAgentStatusTab(
      s.recentlyClosedAgentStatusTabIds,
      tabId ?? getTabIdFromPaneKey(paneKey)
    )
    // Why: main refuses writes for a closed pane or tab too, so a late row is stale.
    if (
      s.programStatusClosedPaneKeys[paneKey] ||
      closedTab ||
      (prev && revision <= prev.revision)
    ) {
      continue
    }
    next = next === s.programStatusByPaneKey ? { ...next } : next
    delete next[paneKey]
    next[paneKey] = { revision, tabId, worktreeId, slot: programStatus }
    changedComposition ||=
      isProgramStatusMirrorRecordVisible(prev) || isProgramStatusMirrorRecordVisible(next[paneKey])
  }
  if (next === s.programStatusByPaneKey) {
    return {}
  }
  // Why: tombstones keep their revision against racing rows, but only up to a bound.
  evictOldestTombstones(next)
  return {
    programStatusByPaneKey: next,
    ...(changedComposition ? { programStatusEpoch: s.programStatusEpoch + 1 } : {})
  }
}

/** Deletes records; `close` also records the closure. Partial: a remote tab sweep has no slot. */
export function programStatusPanesClosedPatch(
  s: Partial<MirrorState>,
  paneKeys: readonly string[],
  close: boolean
): MirrorPatch {
  const records = s.programStatusByPaneKey ?? {}
  const deleted = paneKeys.filter((paneKey) => paneKey in records)
  const patch: MirrorPatch = {}
  if (deleted.length > 0) {
    patch.programStatusByPaneKey = { ...records }
    deleted.forEach((paneKey) => delete patch.programStatusByPaneKey?.[paneKey])
    if (deleted.some((paneKey) => isProgramStatusMirrorRecordVisible(records[paneKey]))) {
      patch.programStatusEpoch = (s.programStatusEpoch ?? 0) + 1
    }
  }
  if (close && paneKeys.length > 0) {
    const closed = { ...s.programStatusClosedPaneKeys }
    for (const paneKey of paneKeys) {
      delete closed[paneKey]
      closed[paneKey] = true
    }
    const overflow = Object.keys(closed).length - PROGRAM_STATUS_MIRROR_BOUND
    Object.keys(closed)
      .slice(0, Math.max(0, overflow))
      .forEach((oldest) => delete closed[oldest])
    patch.programStatusClosedPaneKeys = closed
  }
  return patch
}

export function programStatusTabClosedPatch(s: Partial<MirrorState>, tabId: string): MirrorPatch {
  const paneKeys = Object.entries(s.programStatusByPaneKey ?? {})
    .filter(([paneKey, record]) => record.tabId === tabId || getTabIdFromPaneKey(paneKey) === tabId)
    .map(([paneKey]) => paneKey)
  return paneKeys.length === 0 ? {} : programStatusPanesClosedPatch(s, paneKeys, true)
}

/** The renderer's proof that a live PTY binds the pane again, so slot rows may land there. */
export function programStatusClosureLiftedPatch(
  s: MirrorState,
  paneKeys: readonly string[]
): MirrorPatch {
  const closed = { ...s.programStatusClosedPaneKeys }
  paneKeys.forEach((paneKey) => delete closed[paneKey])
  const lifted = Object.keys(closed).length !== Object.keys(s.programStatusClosedPaneKeys).length
  return lifted ? { programStatusClosedPaneKeys: closed } : {}
}

/** Why `in`: the preference ships with its own switch; until then nothing sets it. */
function readProgramStatusPreferred(settings: AppState['settings']): boolean {
  return (
    !!settings &&
    'agentProgramStatusPreferred' in settings &&
    settings.agentProgramStatusPreferred === true
  )
}

/** One subscription mirrors the preference as a primitive, so caches never key on `settings`. */
export function syncProgramStatusPreferred(state: AppState, previous?: AppState): void {
  const preferred = readProgramStatusPreferred(state.settings)
  // Why `=== true`: a partial test store without the mirror reads as not preferred, unchanged.
  if (
    (!previous || state.settings !== previous.settings) &&
    preferred !== (state.programStatusPreferred === true)
  ) {
    state.setProgramStatusPreferred(preferred)
  }
}

export function createProgramStatusMirrorActions(
  runtime: AgentStatusRuntime
): Pick<
  AgentStatusSlice,
  'applyProgramStatusPaneRows' | 'setProgramStatusPreferred' | 'acknowledgeProgramStatusForPane'
> {
  const { get, set } = runtime
  const setPatch = (build: (s: AppState) => MirrorPatch): void =>
    set((s) => programStatusPatchOrSame(s, build(s)))
  return {
    applyProgramStatusPaneRows: (rows) => setPatch((s) => programStatusRowsPatch(s, rows)),
    setProgramStatusPreferred: (preferred) =>
      setPatch((s) =>
        s.programStatusPreferred === preferred
          ? {}
          : {
              programStatusPreferred: preferred,
              ...(hasVisibleProgramStatus(s.programStatusByPaneKey)
                ? { programStatusEpoch: s.programStatusEpoch + 1 }
                : {})
            }
      ),
    // Why: the optimistic half of a dismissal; main's tombstone of a higher revision replaces it.
    acknowledgeProgramStatusForPane: (paneKey) => {
      const record = get().programStatusByPaneKey[paneKey]
      if (!isProgramStatusMirrorRecordVisible(record)) {
        return
      }
      const { incarnationId, view, shown } = record.slot
      const ack = { incarnationId, view, generation: shown.generation }
      setPatch((s) => ({
        programStatusByPaneKey: {
          ...s.programStatusByPaneKey,
          [paneKey]: { ...record, localHide: ack }
        },
        programStatusEpoch: s.programStatusEpoch + 1
      }))
      if (typeof window !== 'undefined') {
        window.api?.agentStatus?.drop?.(paneKey, ack)
      }
    }
  }
}
