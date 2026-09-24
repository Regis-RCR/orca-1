import { basename } from 'node:path'
import {
  readTerminalComposerState,
  type TerminalComposerState
} from '../../shared/terminal-composer-draft'
import type { TerminalCommandSelfTarget } from '../../shared/terminal-command-contract'
import type { ExactWorkerProviderSession } from '../../shared/orchestration-worker-output'
import type { TuiAgent } from '../../shared/tui-agent'
import type { HeadlessEmulator } from '../daemon/headless-emulator'

/** The runtime members `terminal.command` reads; OrcaRuntimeService supplies them. */
export type TerminalCommandTargetHost = {
  getTerminalAgentStatusPtyId: (handle: string) => string
  getPtyAgent: (ptyId: string) => TuiAgent | null
  headlessTerminals: Map<string, { emulator: HeadlessEmulator }>
  getExactWorkerProviderSession: (
    handle: string,
    observedAfter: number
  ) => ExactWorkerProviderSession | null
}

export type TerminalCommandTarget = {
  ptyId: string
  agent: TuiAgent | null
  selfTarget: TerminalCommandSelfTarget
  /** Transcript and accepted session ids, when the hook server recorded them. */
  receiptSource: { transcriptPath: string; sessionIds: Set<string> } | null
}

function ptyIdOf(host: TerminalCommandTargetHost, handle: string): string | null {
  try {
    return host.getTerminalAgentStatusPtyId(handle)
  } catch {
    return null
  }
}

export function resolveTerminalCommandTarget(
  host: TerminalCommandTargetHost,
  handle: string,
  callerHandle: string | undefined
): TerminalCommandTarget {
  const ptyId = host.getTerminalAgentStatusPtyId(handle)
  // Why: compare PTYs, not handle strings, so a reminted handle for the caller's own pane still matches.
  let selfTarget: TerminalCommandSelfTarget = 'unknown'
  if (callerHandle) {
    const callerPtyId = ptyIdOf(host, callerHandle)
    selfTarget = callerPtyId === null ? 'unknown' : callerPtyId === ptyId
  }
  const session = host.getExactWorkerProviderSession(handle, 0)
  const transcriptPath = session?.providerSession.transcriptPath
  const receiptSource =
    session && session.agent === 'claude' && transcriptPath
      ? {
          transcriptPath,
          // Recent Claude Code names the transcript with a UUID other than the hook session id,
          // and its records carry the file's id, so both are accepted and nothing else is.
          sessionIds: new Set([session.providerSession.id, basename(transcriptPath, '.jsonl')])
        }
      : null
  return { ptyId, agent: host.getPtyAgent(ptyId), selfTarget, receiptSource }
}

/**
 * Three-state composer read of the live pane. The draft is only meaningful when the view sits at
 * the bottom of the buffer, the same condition the tail projection applies.
 */
export function readTerminalCommandComposer(
  host: TerminalCommandTargetHost,
  ptyId: string
): TerminalComposerState {
  const emulator = host.headlessTerminals.get(ptyId)?.emulator
  if (!emulator) {
    return { state: 'unobservable' }
  }
  const range = emulator.getVisibleBufferRange()
  if (range.endExclusive !== range.totalLength) {
    return { state: 'unobservable' }
  }
  return readTerminalComposerState(emulator.getCursorLineContext())
}
