import { describe, expect, it } from 'vitest'
import { sendTerminalOscColorQueryReplies } from './terminal-osc-color-reply'
import { extractHiddenStartupRendererQueryData } from './terminal-reply-query-extraction'
import {
  EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE,
  scanTerminalReplyQuerySequences
} from './terminal-reply-query-scan'

// Only the PTY owner's ingress answers OSC 7501: a viewer or a salvage path that answered too would
// send a second reply, or one after DA1's, and the program would read either as no support.
const BATCH = '\x1b[>0q\x1b[?u\x1b]7501;?\x07\x1b[c'

describe('the OSC 7501 probe outside the PTY owner', () => {
  it('is never salvaged by the hidden-output recovery extractor', () => {
    const extracted = extractHiddenStartupRendererQueryData(BATCH, '')
    expect(extracted.oscColorQueryData).toBe('')
    expect(`${extracted.statelessQueryData}${extracted.statefulQueryData}`).not.toContain('7501')
    expect(extracted.statelessQueryData).toContain('\x1b[c')
    for (let cut = 1; cut < BATCH.length; cut += 1) {
      const first = extractHiddenStartupRendererQueryData(BATCH.slice(0, cut), '')
      const second = extractHiddenStartupRendererQueryData(BATCH.slice(cut), first.pending)
      expect(`${first.oscColorQueryData}${second.oscColorQueryData}`).toBe('')
    }
  })

  it('is never replayed by the stream recovery scan', () => {
    const { queries } = scanTerminalReplyQuerySequences(
      BATCH,
      0,
      EMPTY_TERMINAL_REPLY_QUERY_SCAN_STATE
    )
    expect(queries.map((query) => query.data)).not.toContain('\x1b]7501;?\x07')
    expect(queries.some((query) => query.data.includes('7501'))).toBe(false)
  })

  it('is never answered by a viewer colour responder', () => {
    const sent: string[] = []
    expect(
      sendTerminalOscColorQueryReplies(
        BATCH,
        { foreground: '#000000', background: '#ffffff' },
        (reply) => {
          sent.push(reply)
        }
      )
    ).toBe(false)
    expect(sent).toEqual([])
  })
})
