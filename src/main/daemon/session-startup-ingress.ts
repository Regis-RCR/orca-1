import { PtyStartupIngress } from '../../shared/pty-startup-ingress'
import type { SessionOptions } from './session-options'
import type { TerminalShellRecoveryBarrier } from './terminal-shell-recovery-barrier'

type SessionStartupIngressOptions = Pick<
  SessionOptions,
  'startupIngress' | 'ownerBackend' | 'subprocess'
>

/**
 * A daemon Session's startup ingress, from spawn to teardown. Its emissions feed the
 * recovery barrier, which is flushed after a final snapshot barrier and after the drain.
 */
export class SessionStartupIngress {
  private readonly ingress: PtyStartupIngress

  constructor(
    // Why destructured: a closure over the options would retain the spawn inputs.
    { startupIngress, ownerBackend, subprocess }: SessionStartupIngressOptions,
    private readonly recoveryBarrier: TerminalShellRecoveryBarrier
  ) {
    this.ingress = new PtyStartupIngress({
      ...(startupIngress ? { intent: startupIngress } : {}),
      ...(ownerBackend ? { ownerBackend } : {}),
      write: (data) => subprocess.write(data),
      onEmission: (emission) => this.recoveryBarrier.accept(emission)
    })
  }

  accept(data: string): void {
    this.ingress.accept(data)
  }

  answerLiveQueryReply(reply: string): boolean {
    return this.ingress.answerLiveQueryReply(reply)
  }

  snapshotBarrier(): number {
    return this.ingress.snapshotBarrier()
  }

  /** Releases held ingress bytes, then delivers them with the barrier's queued bytes. */
  flushThroughSnapshotBarrier(): void {
    this.ingress.snapshotBarrier()
    // Why last: snapshotBarrier can emit held spans into the barrier, and a
    // teardown checkpoint mid-episode must not lose the barrier's queued bytes.
    this.recoveryBarrier.flushPending()
  }

  closeQueryAuthority(): number {
    return this.ingress.closeQueryAuthority()
  }

  drainAndClose(): void {
    this.ingress.drainAndClose()
    // Why after drainAndClose: drained ingress bytes re-enter the barrier and can open a
    // fresh episode, and a teardown mid-episode must deliver them with the barrier's queued
    // bytes while clients are still attached, before the session clears them or broadcasts
    // its exit.
    this.recoveryBarrier.flushPending()
  }
}
