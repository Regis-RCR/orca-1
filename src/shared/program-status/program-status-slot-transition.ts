import { programStatusSummariesEqual } from './program-status-projection'
import {
  programStatusViewNameForLiveness,
  type ProgramStatusAck,
  type ProgramStatusIdentity,
  type ProgramStatusLifecycleWrite,
  type ProgramStatusReportWrite,
  type ProgramStatusSlot,
  type ProgramStatusView,
  type ProgramStatusWrite
} from './program-status-slot'

export type ProgramStatusWriteResult = {
  accepted: boolean
  /** The slot after the write: `prev` itself when refused, `undefined` when removed or empty. */
  next: ProgramStatusSlot | undefined
}

function sameIdentity(slot: ProgramStatusSlot, identity: ProgramStatusIdentity): boolean {
  return slot.ptyId === identity.ptyId && slot.incarnationId === identity.incarnationId
}

function slotOf(
  identity: ProgramStatusIdentity,
  reportSeq: number,
  write: ProgramStatusWrite,
  shown: ProgramStatusView | null,
  kept?: ProgramStatusView
): ProgramStatusWriteResult {
  if (shown === null) {
    return { accepted: true, next: undefined }
  }
  const exitedFrom = write.liveness === 'exited' ? (write.prevNow ?? kept) : undefined
  return {
    accepted: true,
    next: {
      ptyId: identity.ptyId,
      incarnationId: identity.incarnationId,
      reportSeq,
      liveness: write.liveness,
      // Why copied, never stamped: a create after a close or an eviction must keep the
      // ledger's instant, or every restore would restart the 30 minute window.
      livenessChangedAt: write.livenessChangedAt,
      view: programStatusViewNameForLiveness(write.liveness),
      shown,
      ...(exitedFrom ? { exitedFrom } : {})
    }
  }
}

function applyReport(
  prev: ProgramStatusSlot | undefined,
  write: ProgramStatusReportWrite
): ProgramStatusWriteResult {
  // The ingress drops a replaced incarnation's facts, so another identity replaces.
  if (prev && sameIdentity(prev, write.identity)) {
    // A stale reportSeq, or a non-exited report after the exit, is refused.
    if (write.reportSeq <= prev.reportSeq) {
      return { accepted: false, next: prev }
    }
    if (prev.liveness === 'exited' && write.liveness !== 'exited') {
      return { accepted: false, next: prev }
    }
  }
  const kept = prev && sameIdentity(prev, write.identity) ? prev.exitedFrom : undefined
  return slotOf(write.identity, write.reportSeq, write, write.shown, kept)
}

function applyLifecycle(
  prev: ProgramStatusSlot | undefined,
  write: ProgramStatusLifecycleWrite
): ProgramStatusWriteResult {
  // Fenced by identity, never by reportSeq; exited is absorbing.
  if (!prev || !sameIdentity(prev, write.identity)) {
    return { accepted: false, next: prev }
  }
  if (prev.liveness === 'exited' && write.liveness !== 'exited') {
    return { accepted: false, next: prev }
  }
  const shown = write.shown === undefined ? prev.shown : write.shown
  // Why kept: a later lifecycle without a proof does not erase the one the exit brought.
  return slotOf(prev, prev.reportSeq, write, shown, prev.exitedFrom)
}

/** The pure acceptance rule of one pane's slot; it reads no clock. */
export function applyProgramStatusWrite(
  prev: ProgramStatusSlot | undefined,
  write: ProgramStatusWrite
): ProgramStatusWriteResult {
  return write.kind === 'report' ? applyReport(prev, write) : applyLifecycle(prev, write)
}

export function isProgramStatusSlotHidden(
  slot: ProgramStatusSlot,
  ack: ProgramStatusAck | undefined
): boolean {
  return (
    ack !== undefined &&
    ack.incarnationId === slot.incarnationId &&
    ack.view === slot.view &&
    ack.generation === slot.shown.generation
  )
}

/**
 * The exit's own rule for a dismissal, keyed by PTY so it holds with no pane record: an ack of
 * exactly the pre-exit `now` view moves to the `onExit` view when that shows the same summary.
 * A coalesced transition gives `prevNow` a newer generation, so nothing is carried.
 */
export function carryAckAcrossExit(
  ack: ProgramStatusAck | undefined,
  identity: ProgramStatusIdentity,
  prevNow: ProgramStatusView | null | undefined,
  onExit: ProgramStatusView | null | undefined
): ProgramStatusAck | undefined {
  if (
    ack === undefined ||
    !prevNow ||
    !onExit ||
    ack.incarnationId !== identity.incarnationId ||
    ack.view !== 'now' ||
    ack.generation !== prevNow.generation ||
    !programStatusSummariesEqual(onExit.summary, prevNow.summary)
  ) {
    return ack
  }
  return { incarnationId: identity.incarnationId, view: 'onExit', generation: onExit.generation }
}
