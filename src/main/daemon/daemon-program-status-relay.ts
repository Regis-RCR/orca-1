import type { PtyStartupIngressIntent } from '../../shared/pty-startup-ingress'
import type { ProgramStatusFact } from '../../shared/program-status/program-status-slot'
import {
  createProgramStatusTracker,
  type ProgramStatusObservation,
  type ProgramStatusTracker,
  type ProgramStatusTrackerOptions
} from '../../shared/program-status/program-status-tracker'
import type { DaemonProgramStatusFact } from './daemon-stream-events'

export type DaemonProgramStatusRelayOptions = Pick<
  ProgramStatusTrackerOptions,
  'timers' | 'monotonicNow'
> & {
  /** The daemon's wall clock; it dates the views, never their order. */
  now?: () => number
}

/** Where a session's facts go: its attached client's stream, or nowhere while none is attached. */
export type DaemonProgramStatusOutlet = {
  incarnationId: string
  emit(fact: DaemonProgramStatusFact): void
}

/**
 * One tracker per daemon Session, fed the startup ingress emissions in byte order. It runs before
 * the stream's keep-tail thinning, so a backgrounded session never loses a report; what a client
 * missed while none was attached is in the createOrAttach reply's snapshot.
 */
export class DaemonProgramStatusRelay {
  private readonly tracker: ProgramStatusTracker
  private readonly now: () => number
  private rawSeq = 0
  private emittedSeq = 0
  private closed = false

  constructor(
    private readonly outlet: DaemonProgramStatusOutlet,
    options: DaemonProgramStatusRelayOptions = {}
  ) {
    const { now = Date.now, ...trackerOptions } = options
    this.now = now
    this.tracker = createProgramStatusTracker({
      ...trackerOptions,
      emit: ({ reportSeq, observation }) => this.send(reportSeq, observation)
    })
  }

  observe(data: string): void {
    if (this.closed) {
      return
    }
    this.tracker.observe(data, this.rawSeq, this.now())
    this.rawSeq += data.length
  }

  /** The current state for the createOrAttach reply; increments nothing. */
  snapshot(): ProgramStatusFact {
    return { incarnationId: this.outlet.incarnationId, ...this.tracker.snapshot() }
  }

  /** At teardown, before the exit broadcast: the throttle may still hold the latest state. */
  close(): void {
    if (this.closed) {
      return
    }
    this.closed = true
    const latest = this.tracker.snapshot()
    if (latest.reportSeq > this.emittedSeq) {
      this.send(latest.reportSeq, latest.observation)
    }
    this.tracker.dispose()
  }

  private send(reportSeq: number, observation: ProgramStatusObservation): void {
    this.emittedSeq = reportSeq
    this.outlet.emit({
      kind: 'program-status',
      incarnationId: this.outlet.incarnationId,
      reportSeq,
      observation
    })
  }
}

/** Armed only when the spawn intent asks for ingestion; every other session costs nothing. */
export function createDaemonProgramStatusRelay(
  intent: PtyStartupIngressIntent | undefined,
  outlet: DaemonProgramStatusOutlet,
  options?: DaemonProgramStatusRelayOptions
): DaemonProgramStatusRelay | null {
  return intent?.programStatus?.ingest === true
    ? new DaemonProgramStatusRelay(outlet, options)
    : null
}
