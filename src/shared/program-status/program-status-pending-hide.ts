import { programStatusSummariesEqual } from './program-status-projection'
import { carryAckAcrossExit, isProgramStatusSlotHidden } from './program-status-slot-transition'
import type { ProgramStatusAck, ProgramStatusSlot, ProgramStatusView } from './program-status-slot'

/**
 * A dismissal not yet sent to main, while its undo toast is open. It is its own operation, keyed
 * by id and bound to the PTY and the exact view it hid, never to a pane record: the record is
 * transient (a move, a retire or a drop deletes it), and the PTY carries its result with it.
 */
export type ProgramStatusPendingHide = {
  ptyId: string
  /** The ack of the view hidden, never rewritten: commit sends it and the host carries it. */
  ack: ProgramStatusAck
  /** The view hidden, summary included. */
  shown: ProgramStatusView
  /** The newest row revision applied, so a stale row cannot move it. */
  revision: number
  /** Undo is no longer offered: the ack leaves as soon as a pane shows the hidden view. */
  committed?: true
}

export type ProgramStatusPendingHides = Record<string, ProgramStatusPendingHide>

let lastOperationId = 0
export function nextProgramStatusHideId(): string {
  lastOperationId += 1
  return `program-status-hide-${lastOperationId}`
}

/**
 * The ack with which this operation hides `slot`: the exact view it hid, or that view's exit,
 * carried by the host's rule on the producer's proof (`exitedFrom`), never on a view remembered here.
 */
export function pendingHideAckFor(
  hide: ProgramStatusPendingHide,
  slot: ProgramStatusSlot | null | undefined
): ProgramStatusAck | null {
  if (!slot || slot.ptyId !== hide.ptyId) {
    return null
  }
  if (isProgramStatusSlotHidden(slot, hide.ack)) {
    return programStatusSummariesEqual(slot.shown.summary, hide.shown.summary) ? hide.ack : null
  }
  const carried = slot.exitedFrom
    ? carryAckAcrossExit(hide.ack, slot, slot.exitedFrom, slot.shown)
    : undefined
  return carried && carried !== hide.ack && isProgramStatusSlotHidden(slot, carried)
    ? carried
    : null
}

/** One row of the operation's PTY: kept while it still hides that PTY's view, else retired. */
function advance(
  hide: ProgramStatusPendingHide,
  slot: ProgramStatusSlot,
  revision: number
): ProgramStatusPendingHide | null {
  return pendingHideAckFor(hide, slot) ? { ...hide, revision } : null
}

/** Applied to every row, even one a closed pane refuses: a newer generation retires it anyway. */
export function advancePendingHides(
  hides: ProgramStatusPendingHides,
  slot: ProgramStatusSlot | null,
  revision: number
): ProgramStatusPendingHides {
  let next = hides
  for (const [id, hide] of Object.entries(hides)) {
    if (!slot || slot.ptyId !== hide.ptyId || revision <= hide.revision) {
      continue
    }
    next = next === hides ? { ...hides } : next
    const advanced = advance(hide, slot, revision)
    if (advanced) {
      next[id] = advanced
    } else {
      delete next[id]
    }
  }
  return next
}

/** The record's local hide is derived, never stored on its own: the first live operation's ack. */
export function derivedLocalHide(
  hides: ProgramStatusPendingHides,
  slot: ProgramStatusSlot | null
): ProgramStatusAck | undefined {
  for (const hide of Object.values(hides)) {
    const ack = pendingHideAckFor(hide, slot)
    if (ack) {
      return ack
    }
  }
  return undefined
}
