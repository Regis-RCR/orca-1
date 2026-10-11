import { programStatusSummariesEqual, type ProgramStatusSummary } from './program-status-projection'
import { createProgramStatusRecordStore } from './program-status-record-store'
import type { ProgramStatusDiscardReason } from './program-status-report'
import {
  createProgramStatusStreamScanner,
  type ProgramStatusScanEvent,
  type ProgramStatusScanSink
} from './program-status-stream-scanner'

export const PROGRAM_STATUS_EMIT_BURST = 8
export const PROGRAM_STATUS_EMIT_PER_SECOND = 20
export const PROGRAM_STATUS_TRAILING_EMIT_MS = 100

/** One side of the projection as the tracker minted it; never minted by a reader. */
export type ProgramStatusView = {
  summary: ProgramStatusSummary
  /** New at every change of this view's summary, from a counter no event resets. */
  generation: number
  /** Owner clock: when the aggregate last changed. */
  changedAt: number
  /** Owner clock: when the root last changed; `null` without a root. */
  rootChangedAt: number | null
}

export type ProgramStatusObservation = {
  now: ProgramStatusView | null
  onExit: ProgramStatusView | null
}

/** Equal `reportSeq` means an identical observation, generations and times included. */
export type ProgramStatusTrackerState = {
  readonly reportSeq: number
  readonly observation: ProgramStatusObservation
}

export type ProgramStatusChangeCause = ProgramStatusScanEvent['kind']

export type ProgramStatusTrackerEmission = ProgramStatusTrackerState & {
  readonly cause: ProgramStatusChangeCause
}

export type ProgramStatusTrackerTimers = {
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export type ProgramStatusTrackerOptions = {
  emit(emission: ProgramStatusTrackerEmission): void
  timers?: ProgramStatusTrackerTimers
  /** Monotonic milliseconds for the emission budget and its timer; never the wall clock. */
  monotonicNow?: () => number
}

export type ProgramStatusTracker = {
  /** Applies events in byte order; `now` is the owner's wall clock and only dates the views. */
  observe(data: string, rawStartSeq: number, now: number): void
  /** The current state, without incrementing anything. */
  snapshot(): ProgramStatusTrackerState
  discards(): Record<ProgramStatusDiscardReason, number>
  /** Clears the trailing timer; every later call is a no-op. */
  dispose(): void
}

const EMPTY: ProgramStatusTrackerState = { reportSeq: 0, observation: { now: null, onExit: null } }

const DEFAULT_TIMERS: ProgramStatusTrackerTimers = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handle came from setTimeout above.
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

const DEFAULT_MONOTONIC_NOW = (): number => performance.now()

class Tracker implements ProgramStatusTracker {
  private readonly store = createProgramStatusRecordStore()
  private readonly scanner = createProgramStatusStreamScanner()
  private readonly timers: ProgramStatusTrackerTimers
  private readonly discardCounts: Record<ProgramStatusDiscardReason, number> = {
    'frame-limit': 0,
    'pair-limit': 0,
    base64: 0,
    control: 0,
    id: 0,
    state: 0
  }
  private latest = EMPTY
  private latestCause: ProgramStatusChangeCause = 'report'
  private generation = 0
  private now = 0
  private emittedSeq = 0
  private tokens = PROGRAM_STATUS_EMIT_BURST
  private refilledAt: number | null = null
  private trailing: { handle: unknown; firesAt: number } | null = null
  private disposed = false
  private readonly sink: ProgramStatusScanSink = {
    isResetArmed: () => this.store.hasRecords(),
    isPromptStartArmed: () => this.store.hasActiveRecords(),
    onEvent: (event) => this.apply(event)
  }

  constructor(
    private readonly emit: ProgramStatusTrackerOptions['emit'],
    timers = DEFAULT_TIMERS,
    private readonly monotonicNow = DEFAULT_MONOTONIC_NOW
  ) {
    this.timers = timers
  }

  observe(data: string, rawStartSeq: number, now: number): void {
    if (this.disposed) {
      return
    }
    this.now = now
    this.scanner.scan(data, rawStartSeq, this.sink)
    if (this.latest.reportSeq > this.emittedSeq) {
      this.flush(this.monotonicNow())
    }
  }

  snapshot(): ProgramStatusTrackerState {
    return this.latest
  }

  discards(): Record<ProgramStatusDiscardReason, number> {
    return { ...this.discardCounts }
  }

  dispose(): void {
    this.disposed = true
    if (this.trailing) {
      this.timers.clearTimeout(this.trailing.handle)
      this.trailing = null
    }
  }

  private apply(event: ProgramStatusScanEvent): void {
    if (event.kind === 'report') {
      if (event.result.kind === 'discard') {
        this.discardCounts[event.result.reason] += 1
        return
      }
      this.store.applyReport(event.result.report)
    } else if (event.kind === 'prompt-start') {
      this.store.applyPromptStart()
    } else {
      this.store.applyReset()
    }
    // Why per event, before any throttling: a coalesced emission must not hide a transition.
    const projection = this.store.project()
    const prev = this.latest.observation
    const now = this.nextView(prev.now, projection.now)
    const onExit = this.nextView(prev.onExit, projection.onExit)
    if (now !== prev.now || onExit !== prev.onExit) {
      this.latest = { reportSeq: this.latest.reportSeq + 1, observation: { now, onExit } }
      this.latestCause = event.kind
    }
  }

  private nextView(
    prev: ProgramStatusView | null,
    summary: ProgramStatusSummary | null
  ): ProgramStatusView | null {
    const unchanged =
      prev === null
        ? summary === null
        : summary !== null && programStatusSummariesEqual(prev.summary, summary)
    if (unchanged) {
      return prev
    }
    this.generation += 1
    if (summary === null) {
      return null
    }
    const rootChanged = prev === null || prev.summary.root !== summary.root
    return {
      summary,
      generation: this.generation,
      changedAt:
        prev === null || prev.summary.aggregate !== summary.aggregate ? this.now : prev.changedAt,
      rootChangedAt: summary.root === null ? null : rootChanged ? this.now : prev.rootChangedAt
    }
  }

  /** Token bucket; the latest observation always goes out, at worst on one trailing timer. */
  private flush(at: number): void {
    const last = this.refilledAt ?? at
    if (at > last) {
      const refill = ((at - last) * PROGRAM_STATUS_EMIT_PER_SECOND) / 1000
      this.tokens = Math.min(PROGRAM_STATUS_EMIT_BURST, this.tokens + refill)
    }
    // Why never backward: an earlier reading must not credit the same interval twice.
    const refilledAt = Math.max(last, at)
    this.refilledAt = refilledAt
    if (this.tokens >= 1) {
      this.tokens -= 1
      if (this.trailing) {
        this.timers.clearTimeout(this.trailing.handle)
        this.trailing = null
      }
      this.emittedSeq = this.latest.reportSeq
      this.emit({ ...this.latest, cause: this.latestCause })
      return
    }
    if (!this.trailing) {
      // Why from the refill instant: a full interval after it always refills a token.
      const firesAt = refilledAt + PROGRAM_STATUS_TRAILING_EMIT_MS
      const handle = this.timers.setTimeout(() => {
        this.trailing = null
        if (!this.disposed && this.latest.reportSeq > this.emittedSeq) {
          // Why not earlier than scheduled: a timer that fires early still finds its token.
          this.flush(Math.max(this.monotonicNow(), firesAt))
        }
      }, PROGRAM_STATUS_TRAILING_EMIT_MS)
      this.trailing = { handle, firesAt }
    }
  }
}

/** One per PTY incarnation, in the process that owns the PTY bytes. */
export function createProgramStatusTracker(
  options: ProgramStatusTrackerOptions
): ProgramStatusTracker {
  return new Tracker(options.emit, options.timers, options.monotonicNow)
}
