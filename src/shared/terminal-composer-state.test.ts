import { describe, expect, it } from 'vitest'
import { readTerminalComposerState, type TerminalCursorContext } from './terminal-composer-draft'

function claudeComposer(overrides: Partial<TerminalCursorContext>): TerminalCursorContext {
  return {
    rows: ['────────', '❯ '],
    typedRows: ['────────', '❯ '],
    promptGlyphBoldRows: [false, false],
    rowsBelow: ['────────'],
    typedRowsBelow: ['────────'],
    beforeCursor: '❯ ',
    afterCursor: '',
    rawAfterCursor: '',
    cursorHidden: false,
    cursorViewportRow: 10,
    ...overrides
  }
}

describe('readTerminalComposerState', () => {
  it('reads an empty Claude composer as empty, not as unobservable', () => {
    expect(readTerminalComposerState(claudeComposer({}))).toEqual({ state: 'empty' })
  })

  it('reads staged text as text', () => {
    expect(
      readTerminalComposerState(
        claudeComposer({
          rows: ['────────', '❯ staged by someone'],
          typedRows: ['────────', '❯ staged by someone'],
          beforeCursor: '❯ staged by someone'
        })
      )
    ).toEqual({ state: 'text', text: 'staged by someone' })
  })

  it('joins a soft-wrapped body into one line', () => {
    expect(
      readTerminalComposerState(
        claudeComposer({
          rows: ['────────', '❯ /goal a wrapped bo', 'dy continues'],
          typedRows: ['────────', '❯ /goal a wrapped bo', 'dy continues'],
          promptGlyphBoldRows: [false, false, false],
          rowsWrapped: [false, false, true],
          beforeCursor: 'dy continues'
        })
      )
    ).toEqual({ state: 'text', text: '/goal a wrapped body continues' })
  })

  it('keeps a hard break inside a body with blank lines', () => {
    const state = readTerminalComposerState(
      claudeComposer({
        rows: ['────────', '❯ /goal first', '  ', '  second'],
        typedRows: ['────────', '❯ /goal first', '  ', '  second'],
        promptGlyphBoldRows: [false, false, false, false],
        rowsWrapped: [false, false, false, false],
        beforeCursor: '  second'
      })
    )
    expect(state.state).toBe('text')
    expect(state.state === 'text' && state.text.replace(/\s+/g, ' ')).toBe('/goal first second')
  })

  it('reads a body whose prompt row left the window as unobservable', () => {
    expect(
      readTerminalComposerState(
        claudeComposer({
          rows: ['  body line 40', '  body line 41'],
          typedRows: ['  body line 40', '  body line 41'],
          promptGlyphBoldRows: [false, false],
          rowsWrapped: [false, false],
          beforeCursor: '  body line 41'
        })
      )
    ).toEqual({ state: 'unobservable' })
  })

  it('reads a missing context or a hidden cursor as unobservable', () => {
    expect(readTerminalComposerState(null)).toEqual({ state: 'unobservable' })
    expect(readTerminalComposerState(claudeComposer({ cursorHidden: true }))).toEqual({
      state: 'unobservable'
    })
  })
})
