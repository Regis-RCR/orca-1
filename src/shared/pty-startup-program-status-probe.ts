// The OSC 7501 support probe, `ESC ] 7501 ; ? ST`, answered only by the PTY owner's ingress.
const PROBE = '\x1b]7501;?'
const BEL = 0x07
const ESC = 0x1b
const BACKSLASH = 0x5c

/**
 * Spec rev 0.4: the default states and kinds, spelled out. Why not the bare `?`, which means the
 * same: it is byte-identical to an ST probe, so its echo would be read as a probe and the next
 * real probe as its echo.
 */
export const PROGRAM_STATUS_PROBE_REPLY =
  '\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\'

export type ProgramStatusProbeParse =
  | { kind: 'program-status'; endIndex: number }
  | { kind: 'partial' }
  | { kind: 'none' }

/**
 * BEL or ST ends the probe; a bare ESC ends it before that ESC, as the stream scanner reads a
 * report. Every strict prefix is `partial`, so a torn probe is held until it can be decided.
 */
export function parseProgramStatusProbe(data: string, offset: number): ProgramStatusProbeParse {
  const fragment = data.slice(offset, offset + PROBE.length)
  if (fragment.length < PROBE.length) {
    return PROBE.startsWith(fragment) ? { kind: 'partial' } : { kind: 'none' }
  }
  if (fragment !== PROBE) {
    return { kind: 'none' }
  }
  const end = offset + PROBE.length
  if (end >= data.length) {
    return { kind: 'partial' }
  }
  const next = data.charCodeAt(end)
  if (next === BEL) {
    return { kind: 'program-status', endIndex: end + 1 }
  }
  if (next !== ESC) {
    return { kind: 'none' }
  }
  if (end + 1 >= data.length) {
    return { kind: 'partial' }
  }
  return {
    kind: 'program-status',
    endIndex: data.charCodeAt(end + 1) === BACKSLASH ? end + 2 : end
  }
}
