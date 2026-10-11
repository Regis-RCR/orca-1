import {
  createProgramStatusTracker,
  type ProgramStatusTracker,
  type ProgramStatusTrackerOptions
} from '../../shared/program-status/program-status-tracker'
import { paneKeyBindingListeners } from '../ipc/pty/pane/key-state'
import type { ProgramStatusIngress } from './program-status-ingress'

/** Local-provider PTYs: main owns the bytes, so the tracker runs here, lossless and in order. */
export type ProgramStatusLocalIngest = {
  begin(ptyId: string, incarnationId: string): void
  /** One Map miss for a PTY that is not tracked. */
  observe(ptyId: string, data: string, at: number): void
  exit(ptyId: string, certified: boolean): void
  prune(ptyId: string): void
}

type Session = { incarnationId: string; tracker: ProgramStatusTracker; seq: number }

export function createProgramStatusLocalIngest(
  ingress: ProgramStatusIngress,
  options: Pick<ProgramStatusTrackerOptions, 'timers' | 'monotonicNow'> = {}
): ProgramStatusLocalIngest {
  const sessions = new Map<string, Session>()
  const end = (ptyId: string): void => {
    const session = sessions.get(ptyId)
    if (session) {
      sessions.delete(ptyId)
      // Why: the throttle may still hold the last state; the exit must see the program's latest.
      ingress.fact(ptyId, { incarnationId: session.incarnationId, ...session.tracker.snapshot() })
      session.tracker.dispose()
    }
  }
  return {
    begin(ptyId, incarnationId) {
      end(ptyId)
      const tracker = createProgramStatusTracker({
        ...options,
        emit: ({ reportSeq, observation }) =>
          ingress.fact(ptyId, { incarnationId, reportSeq, observation })
      })
      sessions.set(ptyId, { incarnationId, tracker, seq: 0 })
      ingress.register(ptyId, { incarnationId, ...tracker.snapshot() })
    },
    observe(ptyId, data, at) {
      const session = sessions.get(ptyId)
      if (session) {
        session.tracker.observe(data, session.seq, at)
        session.seq += data.length
        ingress.settle(ptyId)
      }
    },
    exit(ptyId, certified) {
      if (certified) {
        end(ptyId)
        ingress.exited(ptyId)
      } else {
        ingress.lost(ptyId)
      }
    },
    prune(ptyId) {
      end(ptyId)
      ingress.prune(ptyId)
    }
  }
}

let installed: { ingress: ProgramStatusIngress; local: ProgramStatusLocalIngest } | null = null
const onPaneBound = (paneKey: string): void => installed?.ingress.paneBound(paneKey)

/** Wired once at startup; until then every hook below is a no-op. */
export function installProgramStatusIngress(ingress: ProgramStatusIngress | null): void {
  installed = ingress ? { ingress, local: createProgramStatusLocalIngest(ingress) } : null
  if (ingress) {
    paneKeyBindingListeners.add(onPaneBound)
  } else {
    paneKeyBindingListeners.delete(onPaneBound)
  }
}

export function installedProgramStatusIngress(): typeof installed {
  return installed
}
