import type { ProgramStatusBlockedKind } from './program-status-report'

export type ProgramStatusRecordState = 'working' | 'blocked' | 'done' | 'error' | 'idle'

/** A stored record; `id` is `null` for the root, the ancestor of every record. */
export type ProgramStatusRecord = {
  id: string | null
  state: ProgramStatusRecordState
  kind: ProgramStatusBlockedKind | null
}

export type ProgramStatusSummaryState =
  | 'working'
  | 'blocked'
  | 'question'
  | 'done'
  | 'error'
  | 'idle'

export type ProgramStatusSummary = {
  /** The most urgent state, the one a status dot shows. */
  aggregate: ProgramStatusSummaryState
  /** The root record's own state, `null` without a root record. */
  root: ProgramStatusSummaryState | null
  /** Some non-root record is `error`. */
  childError: boolean
}

/** `null` means no record; `onExit` is what remains once the attached process exits. */
export type ProgramStatusProjection = {
  now: ProgramStatusSummary | null
  onExit: ProgramStatusSummary | null
}

const URGENCY: Record<ProgramStatusSummaryState, number> = {
  blocked: 4,
  question: 4,
  working: 3,
  error: 2,
  done: 1,
  idle: 0
}

function summaryStateOf(record: ProgramStatusRecord): ProgramStatusSummaryState {
  return record.state === 'blocked' && record.kind === 'question' ? 'question' : record.state
}

/** What a child contributes to the aggregate: only the root can fail the main agent. */
function childCandidateOf(record: ProgramStatusRecord): ProgramStatusSummaryState | null {
  switch (record.state) {
    case 'working':
    case 'blocked':
      return summaryStateOf(record)
    case 'done':
    case 'error':
      return 'done'
    case 'idle':
      return null
  }
}

/**
 * Summarize records given oldest update first, so a tie goes to the most recent update.
 * Why idle without candidates: records that are only idle children leave the rule with no
 * candidate, and idle is what every one of them reports.
 */
export function summarizeProgramStatusRecords(
  records: Iterable<ProgramStatusRecord>
): ProgramStatusSummary | null {
  let any = false
  let root: ProgramStatusSummaryState | null = null
  let childError = false
  let aggregate: ProgramStatusSummaryState | null = null
  for (const record of records) {
    any = true
    let candidate: ProgramStatusSummaryState | null
    if (record.id === null) {
      root = summaryStateOf(record)
      candidate = root
    } else {
      childError ||= record.state === 'error'
      candidate = childCandidateOf(record)
    }
    if (candidate !== null && (aggregate === null || URGENCY[candidate] >= URGENCY[aggregate])) {
      aggregate = candidate
    }
  }
  if (!any) {
    return null
  }
  return { aggregate: aggregate ?? 'idle', root, childError }
}
