import { describe, expect, it } from 'vitest'
import type { HeadlessEmulator } from '../daemon/headless-emulator'
import type { TerminalCursorContext } from '../../shared/terminal-composer-draft'
import { compareTerminalCommandDraft } from '../../shared/terminal-command-contract'
import {
  readTerminalCommandComposer,
  resolveTerminalCommandTarget,
  type TerminalCommandTargetHost
} from './terminal-command-target'

const STAGED: TerminalCursorContext = {
  rows: ['────────', '❯ /compact'],
  typedRows: ['────────', '❯ /compact'],
  promptGlyphBoldRows: [false, false],
  rowsBelow: ['────────'],
  typedRowsBelow: ['────────'],
  beforeCursor: '❯ /compact',
  afterCursor: '',
  rawAfterCursor: '',
  cursorHidden: false,
  cursorViewportRow: 10
}

function emulator(atBottom: boolean): HeadlessEmulator {
  return {
    getVisibleBufferRange: () => ({ start: 0, endExclusive: atBottom ? 40 : 30, totalLength: 40 }),
    getCursorLineContext: () => STAGED
  } as unknown as HeadlessEmulator
}

function host(options: {
  ptys?: Record<string, string>
  emulators?: Record<string, HeadlessEmulator>
  transcriptPath?: string
  agent?: 'claude' | 'codex'
}): TerminalCommandTargetHost {
  const ptys = options.ptys ?? { term_target: 'pty-1' }
  return {
    getTerminalAgentStatusPtyId: (handle) => {
      const ptyId = ptys[handle]
      if (!ptyId) {
        throw new Error('terminal_handle_stale')
      }
      return ptyId
    },
    getPtyAgent: () => options.agent ?? 'claude',
    headlessTerminals: new Map(
      Object.entries(options.emulators ?? {}).map(([ptyId, value]) => [ptyId, { emulator: value }])
    ),
    getExactWorkerProviderSession: () =>
      options.transcriptPath
        ? ({
            agent: options.agent ?? 'claude',
            providerSession: {
              key: 'claude',
              id: 'hook-session',
              transcriptPath: options.transcriptPath
            }
          } as unknown as ReturnType<TerminalCommandTargetHost['getExactWorkerProviderSession']>)
        : null
  }
}

describe('readTerminalCommandComposer', () => {
  it('reads the draft when the view sits at the bottom of the buffer', () => {
    const state = readTerminalCommandComposer(
      host({ emulators: { 'pty-1': emulator(true) } }),
      'pty-1'
    )
    expect(state).toEqual({ state: 'text', text: '/compact' })
    expect(
      compareTerminalCommandDraft(state.state === 'text' ? state.text : null, '/compact')
    ).toBe('match')
  })

  it('reads a scrolled view as unobservable, even with a draft on screen', () => {
    expect(
      readTerminalCommandComposer(host({ emulators: { 'pty-1': emulator(false) } }), 'pty-1')
    ).toEqual({ state: 'unobservable' })
  })

  it('reads a pane without a headless emulator as unobservable', () => {
    expect(readTerminalCommandComposer(host({}), 'pty-1')).toEqual({ state: 'unobservable' })
  })
})

describe('resolveTerminalCommandTarget', () => {
  it('detects a self-send by PTY, so a reminted caller handle still matches', () => {
    const h = host({ ptys: { term_target: 'pty-1', term_reminted: 'pty-1', term_other: 'pty-2' } })
    expect(resolveTerminalCommandTarget(h, 'term_target', 'term_reminted').selfTarget).toBe(true)
    expect(resolveTerminalCommandTarget(h, 'term_target', 'term_other').selfTarget).toBe(false)
  })

  it('reports unknown when the caller is absent or does not resolve', () => {
    const h = host({})
    expect(resolveTerminalCommandTarget(h, 'term_target', undefined).selfTarget).toBe('unknown')
    expect(resolveTerminalCommandTarget(h, 'term_target', 'term_gone').selfTarget).toBe('unknown')
  })

  it('accepts the hook session id and the transcript file id, and nothing else', () => {
    const target = resolveTerminalCommandTarget(
      host({ transcriptPath: '/home/u/.claude/projects/p/file-uuid.jsonl' }),
      'term_target',
      undefined
    )
    expect(target.receiptSource?.sessionIds).toEqual(new Set(['hook-session', 'file-uuid']))
  })

  it('has no receipt source for a non-Claude session', () => {
    const target = resolveTerminalCommandTarget(
      host({ transcriptPath: '/x/rollout.jsonl', agent: 'codex' }),
      'term_target',
      undefined
    )
    expect(target.receiptSource).toBeNull()
  })
})
