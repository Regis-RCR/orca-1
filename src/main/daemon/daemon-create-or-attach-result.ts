import type { TuiAgent } from '../../shared/tui-agent'
import type { ShellReadyState, TerminalSnapshot } from './types'
import type { AgentSessionClaimedSpawnResult } from '../../shared/agent-session-host-authority'
import type { PtyIncarnationId } from '../../shared/pty-incarnation'
import type { ProgramStatusFact } from '../../shared/program-status/program-status-slot'

export type DaemonCreateOrAttachResult = {
  isNew: boolean
  snapshot: TerminalSnapshot | null
  pid: number | null
  shellState: ShellReadyState
  historySeeded?: boolean
  launchAgent?: TuiAgent
  /** Undefined only when talking to a daemon predating WSL session context. */
  wslDistro?: string | null
  agentSessionEnsure?: AgentSessionClaimedSpawnResult
  incarnationId?: PtyIncarnationId
  /**
   * Whether the daemon process itself could read the requested cwd at spawn. Only the daemon's own
   * verdict counts: macOS TCC scopes folder access per process tree, so the app's view of the same
   * path proves nothing about the daemon's (#17696). Omitted by daemons predating this field.
   */
  cwdReadableByDaemon?: boolean
  /** v50: the session's OSC 7501 state when the attach routed its stream to this client. */
  programStatus?: ProgramStatusFact
}

export function getDaemonSessionResultMetadata(session: {
  launchAgent: TuiAgent | null
  historySeeded: boolean | undefined
  wslDistro: string | null
  startupIngress?: { programStatusSnapshot(): ProgramStatusFact | undefined }
}): {
  launchAgent?: TuiAgent
  historySeeded?: boolean
  wslDistro: string | null
  programStatus?: ProgramStatusFact
} {
  // Why read after attachClient: every later fact goes to the attached client with a larger
  // reportSeq, and every earlier one, dropped with no client, is at or below this snapshot.
  const programStatus = session.startupIngress?.programStatusSnapshot()
  return {
    ...(programStatus ? { programStatus } : {}),
    ...(session.launchAgent ? { launchAgent: session.launchAgent } : {}),
    ...(session.historySeeded !== undefined ? { historySeeded: session.historySeeded } : {}),
    // Why: null authoritatively identifies a native session; omission is
    // reserved for older daemons that predate this wire field.
    wslDistro: session.wslDistro
  }
}
