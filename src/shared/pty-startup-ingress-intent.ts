import {
  terminalOscColorQueryReplies,
  type TerminalOscColorQueryReplyColors
} from './terminal-osc-color-reply'
import { parseProgramStatusIntent, type ProgramStatusIntent } from './program-status-intent'

export type PtyStartupIngressIntent = {
  colors: TerminalOscColorQueryReplyColors
  kittyKeyboardProtocol?: boolean
  deadlineMs: number
  /** Arms the PTY owner's OSC 7501 tracker; a parser that predates the field drops it. */
  programStatus?: ProgramStatusIntent
}

export const PTY_STARTUP_INGRESS_VERSION = 2

/** `programStatus: false` is the relay's: an owner outside the announced scope never ingests. */
export function parsePtyStartupIngressIntent(
  value: unknown,
  options: { programStatus?: false } = {}
): PtyStartupIngressIntent | undefined {
  if (!value || typeof value !== 'object') {
    return undefined
  }
  const programStatus =
    options.programStatus !== false && 'programStatus' in value
      ? parseProgramStatusIntent(value.programStatus)
      : undefined
  const kittyKeyboardProtocol =
    'kittyKeyboardProtocol' in value && value.kittyKeyboardProtocol === true
  const colors = 'colors' in value ? value.colors : undefined
  const normalizedColors = {
    ...(colors &&
    typeof colors === 'object' &&
    'foreground' in colors &&
    typeof colors.foreground === 'string'
      ? { foreground: colors.foreground }
      : {}),
    ...(colors &&
    typeof colors === 'object' &&
    'background' in colors &&
    typeof colors.background === 'string'
      ? { background: colors.background }
      : {})
  }
  const deadlineMs = 'deadlineMs' in value ? value.deadlineMs : undefined
  if (
    (!kittyKeyboardProtocol &&
      !programStatus &&
      !terminalOscColorQueryReplies(normalizedColors, [10, 11])) ||
    typeof deadlineMs !== 'number' ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs < 0 ||
    deadlineMs > 30_000
  ) {
    return undefined
  }
  return {
    colors: normalizedColors,
    ...(kittyKeyboardProtocol ? { kittyKeyboardProtocol: true } : {}),
    deadlineMs,
    ...(programStatus ? { programStatus } : {})
  }
}
