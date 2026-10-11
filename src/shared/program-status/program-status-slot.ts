// The program-status slot: one per pane in the host's status store, beside the hook row and never
// inside it. Its three counters answer three questions: `reportSeq` (is this report newer, inside
// the incarnation), `liveness` (can the producer still be heard), and the shown view's
// `generation` (did the state the user dismissed change).

import type { ProgramStatusSummary, ProgramStatusSummaryState } from './program-status-projection'
import type { ProgramStatusObservation, ProgramStatusView } from './program-status-tracker'

export type { ProgramStatusObservation, ProgramStatusSummary, ProgramStatusSummaryState }
export type { ProgramStatusView }

export type ProgramStatusViewName = 'now' | 'onExit'
export type ProgramStatusIdentity = { ptyId: string; incarnationId: string }
/** The SSH use case's vocabulary: loss of contact is never evidence of death. */
export type ProgramStatusLiveness = 'live' | 'unverifiable' | 'exited'

export type ProgramStatusSlot = ProgramStatusIdentity & {
  /** The tracker's order inside the incarnation; never minted on the host. */
  reportSeq: number
  /** Changed only by lifecycle writes. */
  liveness: ProgramStatusLiveness
  /** Host clock, the ledger's phase start, carried by every write and never stamped here. */
  livenessChangedAt: number
  /** `onExit` exactly when `liveness` is `exited`. */
  view: ProgramStatusViewName
  /** The selected view; an empty view removes the slot instead. */
  shown: ProgramStatusView
}

/** A user's dismissal, keyed by PTY; it hides exactly this incarnation, view and generation. */
export type ProgramStatusAck = {
  incarnationId: string
  view: ProgramStatusViewName
  generation: number
}

/** The ingress has already picked the view from its phase. */
export type ProgramStatusReportWrite = {
  kind: 'report'
  identity: ProgramStatusIdentity
  reportSeq: number
  shown: ProgramStatusView | null
  liveness: ProgramStatusLiveness
  livenessChangedAt: number
}

/** `shown` omitted keeps the view; `prevNow` rides only on the exit write, for the ack carry. */
export type ProgramStatusLifecycleWrite = {
  kind: 'lifecycle'
  identity: ProgramStatusIdentity
  liveness: ProgramStatusLiveness
  livenessChangedAt: number
  shown?: ProgramStatusView | null
  prevNow?: ProgramStatusView | null
}

export type ProgramStatusWrite = ProgramStatusReportWrite | ProgramStatusLifecycleWrite

/** What crosses from the PTY owner to the host: a fact or an attach snapshot. */
export type ProgramStatusFact = {
  incarnationId: string
  reportSeq: number
  observation: ProgramStatusObservation
}

export const PROGRAM_STATUS_INCARNATION_ID_MAX_LENGTH = 128

const SUMMARY_STATES: readonly ProgramStatusSummaryState[] = [
  'working',
  'blocked',
  'question',
  'done',
  'error',
  'idle'
]

export function programStatusViewNameForLiveness(
  liveness: ProgramStatusLiveness
): ProgramStatusViewName {
  return liveness === 'exited' ? 'onExit' : 'now'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isSummaryState(value: unknown): value is ProgramStatusSummaryState {
  return SUMMARY_STATES.some((state) => state === value)
}

function isIncarnationId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= PROGRAM_STATUS_INCARNATION_ID_MAX_LENGTH
  )
}

function isGeneration(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseSummary(value: unknown): ProgramStatusSummary | null {
  if (!isRecord(value) || !isSummaryState(value.aggregate)) {
    return null
  }
  const { root, childError } = value
  if ((root !== null && !isSummaryState(root)) || typeof childError !== 'boolean') {
    return null
  }
  return { aggregate: value.aggregate, root, childError }
}

/** `undefined` is invalid; `null` is a valid empty view. */
function parseView(value: unknown): ProgramStatusView | null | undefined {
  if (value === null) {
    return null
  }
  if (!isRecord(value)) {
    return undefined
  }
  const summary = parseSummary(value.summary)
  const { generation, changedAt, rootChangedAt } = value
  if (!summary || !isGeneration(generation) || !isTime(changedAt)) {
    return undefined
  }
  // Why: the tracker dates a root exactly when there is one.
  if (summary.root === null ? rootChangedAt !== null : !isTime(rootChangedAt)) {
    return undefined
  }
  return {
    summary,
    generation,
    changedAt,
    rootChangedAt: isTime(rootChangedAt) ? rootChangedAt : null
  }
}

/** Strict codec for the PTY-owner boundary; rebuilds the value from known fields only. */
export function parseProgramStatusFact(value: unknown): ProgramStatusFact | null {
  if (!isRecord(value) || !isIncarnationId(value.incarnationId) || !isRecord(value.observation)) {
    return null
  }
  const { reportSeq } = value
  if (typeof reportSeq !== 'number' || !Number.isSafeInteger(reportSeq) || reportSeq < 0) {
    return null
  }
  const now = parseView(value.observation.now)
  const onExit = parseView(value.observation.onExit)
  if (now === undefined || onExit === undefined) {
    return null
  }
  return { incarnationId: value.incarnationId, reportSeq, observation: { now, onExit } }
}

/** The dismissal argument as it arrives over IPC. */
export function parseProgramStatusAck(value: unknown): ProgramStatusAck | null {
  if (
    !isRecord(value) ||
    !isIncarnationId(value.incarnationId) ||
    !isGeneration(value.generation)
  ) {
    return null
  }
  const { view } = value
  if (view !== 'now' && view !== 'onExit') {
    return null
  }
  return { incarnationId: value.incarnationId, view, generation: value.generation }
}
