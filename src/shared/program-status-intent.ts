/** What a spawn asks of the PTY owner for OSC 7501: track every report it emits, and answer the
 *  support probe ahead of DA1. */
export type ProgramStatusIntent = { ingest: true; answerProbe?: true }

/** Who owns the PTY bytes: main, the persistent daemon, or an SSH relay. */
export type ProgramStatusOwnerProvider = 'local' | 'daemon' | 'relay'

/** Strict: anything but `{ ingest: true }` arms nothing, and unknown fields are dropped. */
export function parseProgramStatusIntent(value: unknown): ProgramStatusIntent | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('ingest' in value) ||
    value.ingest !== true
  ) {
    return undefined
  }
  return 'answerProbe' in value && value.answerProbe === true
    ? { ingest: true, answerProbe: true }
    : { ingest: true }
}

/** The platform half of the announced scope. The settings switch reads it too, so the switch
 *  shows exactly where a spawn can arm ingestion. */
export function isProgramStatusPlatform(platform: string): boolean {
  return platform === 'darwin'
}

/**
 * The announced scope: macOS desktop PTYs owned by main or by the daemon. Ingestion is not gated
 * on a probe, since a program may report without detecting support first. A daemon below the
 * protocol that relays facts has the request stripped where its protocol is known.
 */
export function resolveProgramStatusIntent(target: {
  platform: string
  provider: ProgramStatusOwnerProvider
  serveMode: boolean
}): ProgramStatusIntent | undefined {
  return isProgramStatusPlatform(target.platform) &&
    target.provider !== 'relay' &&
    !target.serveMode
    ? { ingest: true, answerProbe: true }
    : undefined
}

export function withoutProgramStatusIntent<T extends { programStatus?: unknown }>(
  intent: T
): Omit<T, 'programStatus'> {
  const { programStatus: _dropped, ...rest } = intent
  void _dropped
  return rest
}
