import { describe, expect, it } from 'vitest'
import {
  buildTerminalCommandExpectedText,
  compareTerminalCommandDraft,
  normalizeTerminalCommandName,
  normalizeTerminalComposerText,
  validateTerminalCommandArgs
} from './terminal-command-contract'

describe('normalizeTerminalCommandName', () => {
  it('accepts a name with or without the leading slash, plugin names included', () => {
    expect(normalizeTerminalCommandName('compact')).toBe('compact')
    expect(normalizeTerminalCommandName('/compact')).toBe('compact')
    expect(normalizeTerminalCommandName('plugin:name')).toBe('plugin:name')
    expect(normalizeTerminalCommandName('my_cmd-2')).toBe('my_cmd-2')
  })

  it('refuses anything outside the name pattern', () => {
    for (const bad of ['', '/', '//compact', '-x', ':x', 'a b', 'a\rb', 'a\u001bb', 'name!', 'é']) {
      expect(normalizeTerminalCommandName(bad)).toBeNull()
    }
  })
})

describe('validateTerminalCommandArgs', () => {
  it('allows LF but refuses CR and ESC anywhere', () => {
    expect(validateTerminalCommandArgs('line one\nline two')).toBe(true)
    expect(validateTerminalCommandArgs('')).toBe(true)
    expect(validateTerminalCommandArgs('submit\rearly')).toBe(false)
    expect(validateTerminalCommandArgs('reframe\u001b[200~')).toBe(false)
  })
})

describe('buildTerminalCommandExpectedText', () => {
  it('is the slash name, plus one space and the args when present', () => {
    expect(buildTerminalCommandExpectedText('compact')).toBe('/compact')
    expect(buildTerminalCommandExpectedText('goal', 'ship it')).toBe('/goal ship it')
    expect(buildTerminalCommandExpectedText('goal', '')).toBe('/goal')
  })
})

describe('compareTerminalCommandDraft', () => {
  it('matches across soft wraps and collapsed paragraph breaks', () => {
    const expected = '/goal first paragraph\n\nsecond paragraph'
    expect(normalizeTerminalComposerText(expected)).toBe('/goal first paragraph second paragraph')
    expect(compareTerminalCommandDraft('/goal first para graph', expected)).toBe('mismatch')
    expect(compareTerminalCommandDraft('/goal first paragraph\nsecond paragraph', expected)).toBe(
      'match'
    )
  })

  it('reads a missing draft as unobservable, never as a match', () => {
    expect(compareTerminalCommandDraft(null, '/compact')).toBe('unobservable')
  })

  it('reads a different draft as a mismatch', () => {
    expect(compareTerminalCommandDraft('/compact extra', '/compact')).toBe('mismatch')
  })
})
