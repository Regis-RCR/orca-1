import type { PtyOwnerBackend } from './pty-owner-backend'
import type { PtyOwnerColorQueryReplies } from './pty-owner-color-query-replies'
import type { parsePtyStartupQuery } from './pty-startup-query'
import type { PtyStartupReplyDelivery } from './pty-startup-reply-delivery'
import type { TerminalKittyKeyboardModeTracker } from './terminal-kitty-keyboard-mode-tracker'
import type { TerminalOscColorQuerySlot } from './terminal-osc-color-reply'
import { PROGRAM_STATUS_PROBE_REPLY } from './pty-startup-program-status-probe'

/** A startup query parsed in full, as opposed to a partial or disproven candidate. */
export type CompletePtyStartupQuery = Extract<
  ReturnType<typeof parsePtyStartupQuery>,
  { endIndex: number }
>

/** The owner state a startup query is answered from. */
export type PtyStartupQueryAnswerer = {
  readonly delivery: PtyStartupReplyDelivery
  readonly colorQueries: PtyOwnerColorQueryReplies
  readonly kittyModes: TerminalKittyKeyboardModeTracker
  readonly ownerBackend: PtyOwnerBackend
  /** The intent asked this owner to answer the OSC 7501 support probe. */
  readonly programStatusProbe: boolean
}

export type PtyStartupQueryAnswer = {
  /** The query's bytes are removed from the stream instead of passed on. */
  readonly stripped: boolean
  /** The owner answered the Kitty query, which ends the Kitty window. */
  readonly closesKittyQuery: boolean
}

/** `stale`: the query was held past the ingress's continuation window; a probe is then passed on. */
export function answerPtyStartupQuery(
  query: CompletePtyStartupQuery,
  answerer: PtyStartupQueryAnswerer,
  stale = false
): PtyStartupQueryAnswer {
  if (query.kind === 'program-status') {
    // Why written now: the DA1 bytes behind it are answered downstream, so this reply leads.
    const answered = !stale && answerer.delivery.answer(PROGRAM_STATUS_PROBE_REPLY, 'owner')
    return { stripped: answered, closesKittyQuery: false }
  }
  const answered =
    query.kind === 'kitty'
      ? answerer.delivery.answer(`\x1b[?${answerer.kittyModes.flags}u`, 'owner')
      : answerColorQuery(query.slots, answerer)
  return {
    // A failed write passes the query on, except under ConPTY, whose ESC-stripped
    // echo of a downstream reply would leak into a cooked shell (#9651).
    stripped: answered || (answerer.ownerBackend === 'windows-conpty' && query.kind !== 'kitty'),
    closesKittyQuery: query.kind === 'kitty' && answered
  }
}

/** True when at least the first reply landed; a failed write stops the rest in order. */
function answerColorQuery(
  slots: readonly TerminalOscColorQuerySlot[],
  answerer: PtyStartupQueryAnswerer
): boolean {
  const replies = answerer.colorQueries.replies(slots)
  return (
    replies.length > 0 &&
    replies.findIndex((reply) => !answerer.delivery.answer(reply, 'owner')) !== 0
  )
}
