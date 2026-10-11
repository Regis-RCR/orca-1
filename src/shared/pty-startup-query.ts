import { parseTerminalOscColorQuery } from './terminal-osc-color-reply'
import { parseProgramStatusProbe } from './pty-startup-program-status-probe'

const KITTY_QUERY = '\x1b[?u'
const OSC = '\x1b]'

/** Startup owns only the exact Kitty capability query, never mode changes or keystrokes.
 *  `probe`: this owner answers the OSC 7501 support probe (the intent's `answerProbe`). */
export function parsePtyStartupQuery(data: string, offset: number, kitty: boolean, probe = false) {
  if (kitty) {
    if (data.startsWith(KITTY_QUERY, offset)) {
      return { kind: 'kitty' as const, endIndex: offset + KITTY_QUERY.length }
    }
    if (KITTY_QUERY.startsWith(data.slice(offset))) {
      return { kind: 'partial' as const }
    }
  }
  const color = parseTerminalOscColorQuery(data, offset)
  const programStatus =
    probe && color.kind !== 'match' ? parseProgramStatusProbe(data, offset) : null
  return programStatus && programStatus.kind !== 'none' ? programStatus : color
}

/** Next offset that can start a query; once the Kitty window closes only an OSC can. */
export function nextQueryCandidate(data: string, from: number, kitty: boolean): number {
  if (kitty) {
    return data.indexOf('\x1b', from)
  }
  const osc = data.indexOf(OSC, from)
  if (osc !== -1) {
    return osc
  }
  // A read can end right after the ESC that opens an OSC colour query.
  const last = data.length - 1
  return last >= from && data.charCodeAt(last) === 0x1b ? last : -1
}
