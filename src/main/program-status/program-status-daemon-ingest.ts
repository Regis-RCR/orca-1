// Daemon-owned PTYs: the tracker runs in the daemon, before the stream is thinned, and main only
// applies what it relays. Facts and reply snapshots cross a process boundary, so each is parsed
// with the strict codec, and a daemon below protocol 50 is never read at all.

import { supportsProgramStatusFacts } from '../daemon/daemon-protocol-version'
import { parseProgramStatusFact } from '../../shared/program-status/program-status-slot'
import type { PtySpawnResult } from '../providers/pty-spawn-result'
import { installedProgramStatusIngress } from './program-status-local-ingest'

export function ingestDaemonProgramStatusFact(
  protocolVersion: number,
  ptyId: string,
  payload: unknown
): void {
  const fact = supportsProgramStatusFacts(protocolVersion) ? parseProgramStatusFact(payload) : null
  if (fact) {
    installedProgramStatusIngress()?.ingress.fact(ptyId, fact)
  }
}

/**
 * The createOrAttach reply registers its incarnation, or reconnects the one already held. The
 * snapshot is taken off the result, so nothing past the provider ever sees it.
 */
export function takeDaemonProgramStatusSnapshot(
  protocolVersion: number,
  result: PtySpawnResult
): PtySpawnResult {
  const { programStatus, ...rest } = result
  const snapshot = supportsProgramStatusFacts(protocolVersion)
    ? parseProgramStatusFact(programStatus)
    : null
  if (snapshot) {
    installedProgramStatusIngress()?.ingress.register(result.id, snapshot)
  }
  return rest
}

/** The link dropped: Orca can no longer hear these PTYs, which is not evidence of their death. */
export function loseDaemonProgramStatus(ptyIds: Iterable<string>): void {
  const ingress = installedProgramStatusIngress()?.ingress
  for (const ptyId of ingress ? ptyIds : []) {
    ingress?.lost(ptyId)
  }
}
