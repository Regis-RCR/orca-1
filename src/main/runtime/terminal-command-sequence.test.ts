import { describe, expect, it } from 'vitest'
import type { TerminalComposerState } from '../../shared/terminal-composer-draft'
import {
  runTerminalCommandSequence,
  type TerminalCommandGuardReading,
  type TerminalCommandReceiptReading,
  type TerminalCommandSequenceDeps,
  type TerminalCommandSequenceInput
} from './terminal-command-sequence'

const SENDABLE: TerminalCommandGuardReading = {
  ok: true,
  agentStatus: 'idle',
  interactiveWait: null
}

type Harness = {
  deps: TerminalCommandSequenceDeps
  writes: string[]
  composer: TerminalComposerState[]
}

/**
 * A fake terminal whose composer echoes every write, so `match` is the natural reading. Scripts
 * override one reading at a time: `guards[i]` is the i-th guard check, `composerAfter[i]` the
 * reading that replaces the echo after the i-th write.
 */
function harness(options: {
  guards?: TerminalCommandGuardReading[]
  initialComposer?: TerminalComposerState
  composerAfter?: Record<number, TerminalComposerState>
  echo?: boolean
  receipts?: (TerminalCommandReceiptReading | null)[]
  receiptSource?: boolean
  writeAccepted?: (index: number) => boolean
}): Harness {
  const writes: string[] = []
  const composer: TerminalComposerState[] = []
  let guardCalls = 0
  let clock = 0
  let staged = ''
  let receiptCalls = 0
  const echo = options.echo ?? true
  const deps: TerminalCommandSequenceDeps = {
    checkGuards: async () => options.guards?.[guardCalls++] ?? SENDABLE,
    readComposer: async () => {
      const override = options.composerAfter?.[writes.length]
      const reading: TerminalComposerState =
        writes.length === 0
          ? (options.initialComposer ?? { state: 'empty' })
          : (override ??
            (echo && staged ? { state: 'text', text: staged } : { state: 'unobservable' }))
      composer.push(reading)
      return reading
    },
    write: async (data) => {
      const accepted = options.writeAccepted?.(writes.length) ?? true
      if (!accepted) {
        return false
      }
      writes.push(data)
      if (data !== '\r') {
        staged += data
      }
      return true
    },
    sleep: async (ms) => {
      clock += ms
    },
    now: () => clock,
    ...(options.receiptSource === false
      ? {}
      : {
          receipt: {
            start: async () => true,
            poll: async () => {
              const reading =
                options.receipts?.[Math.min(receiptCalls, options.receipts.length - 1)]
              receiptCalls += 1
              return reading === undefined ? { stage: 'input_accepted' } : reading
            }
          }
        })
  }
  return { deps, writes, composer }
}

function input(
  overrides: Partial<TerminalCommandSequenceInput> = {}
): TerminalCommandSequenceInput {
  return {
    handle: 'term_1',
    name: 'compact',
    requireDraft: false,
    waitReceiptMs: 0,
    selfTarget: false,
    ...overrides
  }
}

describe('runTerminalCommandSequence', () => {
  it('writes the name, the args and the Enter as three separate raw writes, no paste framing', async () => {
    const h = harness({})
    const result = await runTerminalCommandSequence(
      input({ name: 'goal', args: 'ship it' }),
      h.deps
    )
    expect(h.writes).toEqual(['/goal', ' ship it', '\r'])
    expect(h.writes.join('')).not.toContain('\u001b[200~')
    expect(result.refusal).toBeUndefined()
    expect(result.draftCheck).toBe('match')
    expect(result.writes).toEqual([
      { kind: 'command', bytes: 5 },
      { kind: 'args', bytes: 8 },
      { kind: 'submit', bytes: 1 }
    ])
    expect(result.bytesWritten).toBe(14)
    expect(result.argsBytes).toBe(7)
  })

  it('refuses with zero writes when a permission prompt is open', async () => {
    const h = harness({
      guards: [{ ok: false, code: 'agent_awaiting_permission', message: 'permission' }]
    })
    const result = await runTerminalCommandSequence(input(), h.deps)
    expect(h.writes).toEqual([])
    expect(result.bytesWritten).toBe(0)
    expect(result.refusal?.code).toBe('agent_awaiting_permission')
  })

  it('refuses with zero writes when an AskUserQuestion wait is open', async () => {
    const h = harness({
      guards: [{ ok: false, code: 'agent_awaiting_answer', message: 'waiting' }]
    })
    const result = await runTerminalCommandSequence(input(), h.deps)
    expect(h.writes).toEqual([])
    expect(result.refusal?.code).toBe('agent_awaiting_answer')
  })

  it('refuses with zero writes when the composer holds staged text', async () => {
    const h = harness({ initialComposer: { state: 'text', text: 'someone typed this' } })
    const result = await runTerminalCommandSequence(input(), h.deps)
    expect(h.writes).toEqual([])
    expect(result.refusal?.code).toBe('composer_not_empty')
  })

  it('refuses with zero writes when the composer cannot be read before write 1', async () => {
    const h = harness({ initialComposer: { state: 'unobservable' } })
    const result = await runTerminalCommandSequence(input(), h.deps)
    expect(h.writes).toEqual([])
    expect(result.refusal?.code).toBe('composer_not_observable')
  })

  it('withholds the Enter when the status flips between write 1 and the Enter', async () => {
    const h = harness({
      guards: [SENDABLE, { ok: false, code: 'agent_awaiting_permission', message: 'permission' }]
    })
    const result = await runTerminalCommandSequence(input(), h.deps)
    expect(h.writes).toEqual(['/compact'])
    expect(h.writes).not.toContain('\r')
    expect(result.refusal?.code).toBe('agent_awaiting_permission')
    expect(result.stagedText).toBe(true)
    expect(result.bytesWritten).toBe(8)
  })

  it('rechecks the guards before the args write, not only before the Enter', async () => {
    const h = harness({
      guards: [SENDABLE, { ok: false, code: 'agent_awaiting_answer', message: 'waiting' }]
    })
    const result = await runTerminalCommandSequence(input({ name: 'goal', args: 'body' }), h.deps)
    expect(h.writes).toEqual(['/goal'])
    expect(result.refusal?.code).toBe('agent_awaiting_answer')
    expect(result.stagedText).toBe(true)
  })

  it('withholds the Enter on a mismatching draft', async () => {
    const h = harness({ composerAfter: { 1: { state: 'text', text: '/compact and more' } } })
    const result = await runTerminalCommandSequence(input(), h.deps)
    expect(h.writes).not.toContain('\r')
    expect(result.draftCheck).toBe('mismatch')
    expect(result.stagedText).toBe(true)
    expect(result.refusal?.code).toBe('composer_not_empty')
  })

  it('withholds the Enter on an unobservable draft when --require-draft is set', async () => {
    const h = harness({ echo: false })
    const result = await runTerminalCommandSequence(input({ requireDraft: true }), h.deps)
    expect(h.writes).toEqual(['/compact'])
    expect(result.refusal?.code).toBe('composer_not_observable')
    expect(result.stagedText).toBe(true)
  })

  it('falls back to the Enter on an unobservable draft without --require-draft', async () => {
    const h = harness({ echo: false })
    const result = await runTerminalCommandSequence(input(), h.deps)
    expect(h.writes).toEqual(['/compact', '\r'])
    expect(result.draftCheck).toBe('unobservable')
    expect(result.refusal).toBeUndefined()
  })

  it('reports input_accepted without waiting when --wait-receipt is 0', async () => {
    const h = harness({ receipts: [{ stage: 'input_accepted' }] })
    const result = await runTerminalCommandSequence(input(), h.deps)
    expect(result.receipt).toEqual({ stage: 'input_accepted', source: 'transcript' })
  })

  it('waits for the executed record, never resending', async () => {
    const h = harness({
      receipts: [
        { stage: 'input_accepted' },
        { stage: 'queued', record: 'enqueue' },
        { stage: 'executed', record: 'compact_boundary' }
      ]
    })
    const result = await runTerminalCommandSequence(input({ waitReceiptMs: 10_000 }), h.deps)
    expect(result.receipt).toEqual({
      stage: 'executed',
      source: 'transcript',
      record: 'compact_boundary'
    })
    expect(h.writes.filter((write) => write === '\r')).toHaveLength(1)
  })

  it('stops a self-targeted turn-boundary command at queued', async () => {
    const h = harness({
      receipts: [
        { stage: 'queued', record: 'enqueue' },
        { stage: 'executed', record: 'compact_boundary' }
      ]
    })
    const result = await runTerminalCommandSequence(
      input({ waitReceiptMs: 10_000, selfTarget: true }),
      h.deps
    )
    expect(result.receipt?.stage).toBe('queued')
  })

  it('lets a self-targeted rename reach executed', async () => {
    const h = harness({
      receipts: [
        { stage: 'queued', record: 'enqueue' },
        { stage: 'executed', record: 'custom-title' }
      ]
    })
    const result = await runTerminalCommandSequence(
      input({ name: 'rename', args: 'w-1', waitReceiptMs: 10_000, selfTarget: true }),
      h.deps
    )
    expect(result.receipt?.stage).toBe('executed')
  })

  it('reports unverifiable, never executed, when no receipt source is readable', async () => {
    const noSource = harness({ receiptSource: false })
    expect((await runTerminalCommandSequence(input(), noSource.deps)).receipt).toEqual({
      stage: 'unverifiable',
      source: 'none'
    })
    const unreadable = harness({ receipts: [null] })
    expect(
      (await runTerminalCommandSequence(input({ waitReceiptMs: 1_000 }), unreadable.deps)).receipt
    ).toEqual({ stage: 'unverifiable', source: 'transcript' })
  })

  it('stops at the deadline with the best stage seen, never downgrading', async () => {
    const h = harness({
      receipts: [{ stage: 'queued', record: 'enqueue' }, { stage: 'input_accepted' }]
    })
    const result = await runTerminalCommandSequence(input({ waitReceiptMs: 1_000 }), h.deps)
    expect(result.receipt).toEqual({ stage: 'queued', source: 'transcript', record: 'enqueue' })
  })

  it('withholds the Enter when the terminal stops accepting input mid-sequence', async () => {
    const h = harness({ writeAccepted: (index) => index === 0 })
    const result = await runTerminalCommandSequence(input({ name: 'goal', args: 'x' }), h.deps)
    expect(h.writes).toEqual(['/goal'])
    expect(result.stagedText).toBe(true)
    expect(result.refusal?.code).toBe('agent_status_unknown')
  })

  it('throws, writing nothing, when the terminal refuses the first write', async () => {
    const h = harness({ writeAccepted: () => false })
    await expect(runTerminalCommandSequence(input(), h.deps)).rejects.toThrow(
      'terminal_not_writable'
    )
    expect(h.writes).toEqual([])
  })
})
