import {
  isProgramStatusMirrorRecordVisible,
  type ProgramStatusMirrorRecord
} from '../../../../shared/program-status/program-status-pane-payload'
import type { AppState } from '../types'
import type { AgentStatusRuntime } from './agent-status-runtime'
import type { AgentStatusSlice } from './agent-status-slice-contract'
import {
  derivedLocalHide,
  nextProgramStatusHideId,
  pendingHideAckFor,
  type ProgramStatusPendingHide,
  type ProgramStatusPendingHides
} from '../../../../shared/program-status/program-status-pending-hide'

// Why the mirror's bound: an operation outlives its toast only while its PTY is away.
const PENDING_HIDE_BOUND = 500
const NO_HIDES: ProgramStatusPendingHides = Object.freeze({})

const hidesOf = (s: AppState): ProgramStatusPendingHides => s.programStatusPendingHides ?? NO_HIDES

function bounded(hides: ProgramStatusPendingHides): ProgramStatusPendingHides {
  const excess = Object.keys(hides).length - PENDING_HIDE_BOUND
  Object.keys(hides)
    .slice(0, Math.max(0, excess))
    .forEach((oldest) => delete hides[oldest])
  return hides
}

/** Re-derives the records an operation hid, once it is gone. */
function rederive(
  records: Record<string, ProgramStatusMirrorRecord>,
  hides: ProgramStatusPendingHides,
  gone: ProgramStatusPendingHide
): Record<string, ProgramStatusMirrorRecord> {
  let next = records
  for (const [paneKey, record] of Object.entries(records)) {
    if (!pendingHideAckFor(gone, record.slot)) {
      continue
    }
    const localHide = derivedLocalHide(hides, record.slot)
    const rederived: ProgramStatusMirrorRecord = { ...record }
    delete rederived.localHide
    next = next === records ? { ...records } : next
    next[paneKey] = localHide ? { ...rederived, localHide } : rederived
  }
  return next
}

/** Dismissal as an operation: hide now, then commit or undo it by its id alone. */
export function createProgramStatusHideActions(runtime: AgentStatusRuntime): {
  actions: Pick<
    AgentStatusSlice,
    | 'acknowledgeProgramStatusForPane'
    | 'hideProgramStatusForPane'
    | 'revealProgramStatusForPane'
    | 'commitProgramStatusHide'
  >
  sendCommittedHides: () => void
} {
  const { get, set } = runtime

  /** A committed operation's ack leaves once a pane shows the exact view it hid. */
  const sendCommittedHides = (): void => {
    const s = get()
    const sent: string[] = []
    for (const [id, hide] of Object.entries(hidesOf(s))) {
      const shownAt =
        hide.committed &&
        Object.entries(s.programStatusByPaneKey).find(([, record]) =>
          pendingHideAckFor(hide, record.slot)
        )
      if (shownAt) {
        sent.push(id)
        if (typeof window !== 'undefined') {
          window.api?.agentStatus?.drop?.(shownAt[0], hide.ack)
        }
      }
    }
    if (sent.length > 0) {
      set((state) => {
        const hides = { ...hidesOf(state) }
        sent.forEach((id) => delete hides[id])
        return { programStatusPendingHides: hides }
      })
    }
  }

  const hide = (paneKey: string): string | null => {
    const record = get().programStatusByPaneKey[paneKey]
    if (!isProgramStatusMirrorRecordVisible(record)) {
      return null
    }
    const { ptyId, incarnationId, view, shown } = record.slot
    const id = nextProgramStatusHideId()
    const operation: ProgramStatusPendingHide = {
      ptyId,
      ack: { incarnationId, view, generation: shown.generation },
      shown,
      revision: record.revision
    }
    set((s) => ({
      programStatusPendingHides: bounded({ ...hidesOf(s), [id]: operation }),
      programStatusByPaneKey: {
        ...s.programStatusByPaneKey,
        [paneKey]: { ...record, localHide: operation.ack }
      },
      programStatusEpoch: s.programStatusEpoch + 1
    }))
    return id
  }

  const commit = (id: string): void => {
    const operation = hidesOf(get())[id]
    if (!operation) {
      return
    }
    set((s) => ({
      programStatusPendingHides: { ...hidesOf(s), [id]: { ...operation, committed: true } }
    }))
    sendCommittedHides()
  }

  return {
    sendCommittedHides,
    actions: {
      // Why: the optimistic half of a dismissal; main's tombstone of a higher revision replaces it.
      acknowledgeProgramStatusForPane: (paneKey) => {
        const id = hide(paneKey)
        if (id) {
          commit(id)
        }
      },
      hideProgramStatusForPane: hide,
      revealProgramStatusForPane: (id) =>
        set((s) => {
          const operation = hidesOf(s)[id]
          if (!operation) {
            return s
          }
          const hides = { ...hidesOf(s) }
          delete hides[id]
          const records = rederive(s.programStatusByPaneKey, hides, operation)
          return {
            programStatusPendingHides: hides,
            ...(records === s.programStatusByPaneKey
              ? {}
              : { programStatusByPaneKey: records, programStatusEpoch: s.programStatusEpoch + 1 })
          }
        }),
      commitProgramStatusHide: commit
    }
  }
}
