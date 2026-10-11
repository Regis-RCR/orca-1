// One PTY's producer-side state in main: what the tracker last reported and what lifecycle Orca
// observed. Pure: every event returns the next ledger and the store writes it calls for, and none
// of them mints a reportSeq or a generation.

import type {
  ProgramStatusFact,
  ProgramStatusIdentity,
  ProgramStatusLifecycleWrite,
  ProgramStatusLiveness,
  ProgramStatusObservation,
  ProgramStatusReportWrite,
  ProgramStatusView
} from '../../shared/program-status/program-status-slot'

export type ProgramStatusLedger = {
  readonly ptyId: string
  /** `null` until the incarnation registers; facts that arrive earlier wait in `pending`. */
  readonly incarnationId: string | null
  readonly reportSeq: number
  readonly observation: ProgramStatusObservation
  readonly phase: ProgramStatusLiveness
  /** Main clock at the phase's start; every write carries it as `livenessChangedAt`. */
  readonly phaseChangedAt: number
  /** The highest fact per not-yet-registered incarnation, at most two incarnations. */
  readonly pending: readonly ProgramStatusFact[]
}

export type ProgramStatusLedgerStep = {
  readonly ledger: ProgramStatusLedger
  readonly report?: ProgramStatusReportWrite
  readonly lifecycle?: ProgramStatusLifecycleWrite
  /** The replaced incarnation, whose slot is forgotten when the new one shows nothing. */
  readonly replaced?: ProgramStatusIdentity
}

const PENDING_INCARNATIONS_MAX = 2
const EMPTY: ProgramStatusObservation = { now: null, onExit: null }

export function createProgramStatusLedger(ptyId: string, at: number): ProgramStatusLedger {
  return {
    ptyId,
    incarnationId: null,
    reportSeq: 0,
    observation: EMPTY,
    phase: 'live',
    phaseChangedAt: at,
    pending: []
  }
}

export function programStatusLedgerIdentity(
  ledger: ProgramStatusLedger
): ProgramStatusIdentity | null {
  return ledger.incarnationId === null
    ? null
    : { ptyId: ledger.ptyId, incarnationId: ledger.incarnationId }
}

/** Once exited, the producer's last `now` view is the one the exit followed: its proof. */
function exitProof(ledger: ProgramStatusLedger): { prevNow?: ProgramStatusView } {
  const { now } = ledger.observation
  return ledger.phase === 'exited' && now ? { prevNow: now } : {}
}

/** What a resync or a rekey fallback republishes: the ledger's own `reportSeq`, never a new one. */
export function programStatusLedgerReport(
  ledger: ProgramStatusLedger
): ProgramStatusReportWrite | undefined {
  const identity = programStatusLedgerIdentity(ledger)
  if (!identity) {
    return undefined
  }
  const { now, onExit } = ledger.observation
  return {
    kind: 'report',
    identity,
    reportSeq: ledger.reportSeq,
    shown: ledger.phase === 'exited' ? onExit : now,
    liveness: ledger.phase,
    livenessChangedAt: ledger.phaseChangedAt,
    ...exitProof(ledger)
  }
}

/** The lifecycle write that brings a stored slot to the ledger's phase, `onExit` once exited. */
export function programStatusLedgerLifecycle(
  ledger: ProgramStatusLedger
): ProgramStatusLifecycleWrite | undefined {
  const identity = programStatusLedgerIdentity(ledger)
  const exited =
    ledger.phase === 'exited' ? { shown: ledger.observation.onExit, ...exitProof(ledger) } : {}
  return identity
    ? {
        kind: 'lifecycle',
        identity,
        liveness: ledger.phase,
        livenessChangedAt: ledger.phaseChangedAt,
        ...exited
      }
    : undefined
}

function withReport(ledger: ProgramStatusLedger): ProgramStatusLedgerStep {
  return { ledger, report: programStatusLedgerReport(ledger) }
}

/** A fact or a snapshot of the registered incarnation; anything else is held or dropped. */
export function applyProgramStatusFact(
  ledger: ProgramStatusLedger,
  fact: ProgramStatusFact
): ProgramStatusLedgerStep {
  if (ledger.incarnationId === null) {
    const held = ledger.pending.find((entry) => entry.incarnationId === fact.incarnationId)
    if (held && held.reportSeq >= fact.reportSeq) {
      return { ledger }
    }
    const others = ledger.pending.filter((entry) => entry !== held)
    const pending = [...others, fact].slice(-PENDING_INCARNATIONS_MAX)
    return { ledger: { ...ledger, pending } }
  }
  // Why: a replaced incarnation's late fact is dropped by its id, an equal one is a no-op.
  if (fact.incarnationId !== ledger.incarnationId || fact.reportSeq <= ledger.reportSeq) {
    return { ledger }
  }
  return withReport({ ...ledger, reportSeq: fact.reportSeq, observation: fact.observation })
}

/**
 * Registration adopts max(snapshot, pending of that incarnation) and discards the other pending.
 * The incarnation already held is a reattach: a reconnect, its report first, then `live`.
 */
export function registerProgramStatusIncarnation(
  ledger: ProgramStatusLedger,
  snapshot: ProgramStatusFact,
  at: number
): ProgramStatusLedgerStep {
  const { incarnationId } = snapshot
  if (incarnationId === ledger.incarnationId) {
    return reconnectProgramStatusLedger(ledger, snapshot, at)
  }
  const held = ledger.pending.find((entry) => entry.incarnationId === incarnationId)
  const first = held && held.reportSeq > snapshot.reportSeq ? held : snapshot
  const replaced = programStatusLedgerIdentity(ledger) ?? undefined
  const next: ProgramStatusLedger = {
    ...createProgramStatusLedger(ledger.ptyId, at),
    incarnationId,
    reportSeq: first.reportSeq,
    observation: first.observation
  }
  return { ...withReport(next), ...(replaced ? { replaced } : {}) }
}

function lifecycleStep(
  ledger: ProgramStatusLedger,
  phase: ProgramStatusLiveness,
  at: number
): ProgramStatusLedgerStep {
  const next = { ...ledger, phase, phaseChangedAt: at }
  // Why every exited write carries `prevNow`: the store carries a dismissal across it by PTY, and
  // a write refused while the pane is closed must not take the proof with it.
  const lifecycle = programStatusLedgerLifecycle(next)
  return lifecycle ? { ledger: next, lifecycle } : { ledger: next }
}

/** Certified death: `onExit` replaces the view, at the instant Orca observed it. */
export function exitProgramStatusLedger(
  ledger: ProgramStatusLedger,
  at: number
): ProgramStatusLedgerStep {
  return ledger.phase === 'exited' ? { ledger } : lifecycleStep(ledger, 'exited', at)
}

/** Unconfirmed loss or a daemon disconnect; the window starts once, never again while it lasts. */
export function loseProgramStatusLedger(
  ledger: ProgramStatusLedger,
  at: number
): ProgramStatusLedgerStep {
  return ledger.phase === 'live' ? lifecycleStep(ledger, 'unverifiable', at) : { ledger }
}

/** A reconnect snapshot: its report first when newer, then the phase back to `live`. */
export function reconnectProgramStatusLedger(
  ledger: ProgramStatusLedger,
  snapshot: ProgramStatusFact,
  at: number
): ProgramStatusLedgerStep {
  const reported = applyProgramStatusFact(ledger, snapshot)
  if (reported.ledger.phase !== 'unverifiable' || reported.ledger.incarnationId === null) {
    return reported
  }
  const revived = lifecycleStep(reported.ledger, 'live', at)
  return { ...revived, ...(reported.report ? { report: reported.report } : {}) }
}
