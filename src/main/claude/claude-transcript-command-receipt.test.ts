import { execFileSync } from 'node:child_process'
import { appendFile, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  parseClaudeCommandReceipt,
  readClaudeTranscriptSince,
  statClaudeTranscriptSize
} from './claude-transcript-command-receipt'

const SESSION = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-2222-4333-8444-555555555555'

function line(record: Record<string, unknown>): string {
  return JSON.stringify(record)
}

describe('parseClaudeCommandReceipt', () => {
  const ids = new Set([SESSION])

  it('reads a queued compact from its enqueue record, then executed from the boundary', () => {
    const enqueue = line({
      type: 'queue-operation',
      operation: 'enqueue',
      content: '/compact',
      sessionId: SESSION
    })
    expect(parseClaudeCommandReceipt([enqueue], 'compact', ids)).toEqual({
      stage: 'queued',
      record: 'enqueue'
    })
    const boundary = line({
      type: 'system',
      subtype: 'compact_boundary',
      compactMetadata: { trigger: 'manual' },
      sessionId: SESSION
    })
    expect(parseClaudeCommandReceipt([enqueue, boundary], 'compact', ids)).toEqual({
      stage: 'executed',
      record: 'compact_boundary'
    })
  })

  it('reads rename, color and goal from their command-specific records', () => {
    expect(
      parseClaudeCommandReceipt(
        [line({ type: 'custom-title', customTitle: 'w-1', sessionId: SESSION })],
        'rename',
        ids
      )
    ).toEqual({ stage: 'executed', record: 'custom-title' })
    expect(
      parseClaudeCommandReceipt(
        [line({ type: 'agent-color', agentColor: 'green', sessionId: SESSION })],
        'color',
        ids
      )
    ).toEqual({ stage: 'executed', record: 'agent-color' })
    expect(
      parseClaudeCommandReceipt(
        [
          line({
            type: 'attachment',
            attachment: { type: 'goal_status', met: false },
            sessionId: SESSION
          })
        ],
        'goal',
        ids
      )
    ).toEqual({ stage: 'executed', record: 'goal_status' })
  })

  it('ignores a record from another session id', () => {
    const lines = [
      line({ type: 'custom-title', customTitle: 'other', sessionId: OTHER }),
      line({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '/rename x',
        sessionId: OTHER
      })
    ]
    expect(parseClaudeCommandReceipt(lines, 'rename', ids)).toEqual({ stage: 'input_accepted' })
  })

  it('does not credit one command with another command record', () => {
    const lines = [
      line({ type: 'agent-color', agentColor: 'green', sessionId: SESSION }),
      line({
        type: 'queue-operation',
        operation: 'enqueue',
        content: '/color green',
        sessionId: SESSION
      })
    ]
    expect(parseClaudeCommandReceipt(lines, 'rename', ids)).toEqual({ stage: 'input_accepted' })
    expect(
      parseClaudeCommandReceipt(
        [
          line({
            type: 'queue-operation',
            operation: 'enqueue',
            content: '/goalkeeper',
            sessionId: SESSION
          })
        ],
        'goal',
        ids
      )
    ).toEqual({ stage: 'input_accepted' })
  })

  it('skips a torn or non-JSON line instead of failing the whole read', () => {
    const lines = [
      '{"type":"custom-ti',
      'not json',
      line({ type: 'custom-title', sessionId: SESSION })
    ]
    expect(parseClaudeCommandReceipt(lines, 'rename', ids)).toEqual({
      stage: 'executed',
      record: 'custom-title'
    })
  })
})

describe('readClaudeTranscriptSince', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'orca-command-receipt-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns only complete lines appended after the offset', async () => {
    const path = join(dir, 'session.jsonl')
    await writeFile(path, 'before\n')
    const offset = await statClaudeTranscriptSize(path)
    expect(offset).toBe(7)
    await appendFile(path, 'first\nsecond\npartial')
    expect(await readClaudeTranscriptSince(path, offset!)).toEqual({
      lines: ['first', 'second'],
      consumed: 13
    })
  })

  it('counts consumed bytes, not characters, so the next read starts on a line boundary', async () => {
    const path = join(dir, 'session.jsonl')
    await writeFile(path, 'é\n')
    const first = await readClaudeTranscriptSince(path, 0)
    expect(first).toEqual({ lines: ['é'], consumed: 3 })
    await appendFile(path, 'next\n')
    expect(await readClaudeTranscriptSince(path, first!.consumed)).toEqual({
      lines: ['next'],
      consumed: 5
    })
  })

  it('moves past a line longer than the read bound instead of stalling on it', async () => {
    const path = join(dir, 'session.jsonl')
    await writeFile(path, 'x'.repeat(64))
    expect(await readClaudeTranscriptSince(path, 0, 16)).toEqual({ lines: [], consumed: 16 })
    expect(await readClaudeTranscriptSince(path, 0)).toEqual({ lines: [], consumed: 0 })
  })

  it('reads an unreadable transcript as null, never as an empty success', async () => {
    expect(await statClaudeTranscriptSize(join(dir, 'missing.jsonl'))).toBeNull()
    expect(await readClaudeTranscriptSince(join(dir, 'missing.jsonl'), 0)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('refuses a symlinked transcript', async () => {
    const target = join(dir, 'target.jsonl')
    await writeFile(target, 'secret\n')
    const link = join(dir, 'link.jsonl')
    await symlink(target, link)
    expect(await statClaudeTranscriptSize(link)).toBeNull()
    expect(await readClaudeTranscriptSince(link, 0)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('does not block on a FIFO', async () => {
    const fifo = join(dir, 'fifo.jsonl')
    execFileSync('mkfifo', [fifo])
    expect(await readClaudeTranscriptSince(fifo, 0)).toBeNull()
  })
})
