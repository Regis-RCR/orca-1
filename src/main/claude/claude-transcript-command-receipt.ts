import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type {
  RuntimeTerminalCommandReceipt,
  TerminalCommandReceiptStage
} from '../../shared/terminal-command-contract'

// Why: the same open flags #22079 adds to the other Claude transcript readers. O_NOFOLLOW refuses a
// symlink swapped in for the transcript; O_NONBLOCK keeps a FIFO from stalling the read forever.
const TRANSCRIPT_OPEN_FLAGS =
  constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)

/** Bound on bytes read per receipt poll: a slash command's records land within a few KiB. */
const MAX_RECEIPT_READ_BYTES = 4 * 1024 * 1024

type CommandReceiptRecord = NonNullable<RuntimeTerminalCommandReceipt['record']>

// Only these commands have a record that proves execution; any other command stops at `queued`.
const EXECUTED_RECORD_BY_COMMAND: Record<string, CommandReceiptRecord> = {
  compact: 'compact_boundary',
  rename: 'custom-title',
  color: 'agent-color',
  goal: 'goal_status'
}

function executedRecordOf(value: Record<string, unknown>): CommandReceiptRecord | null {
  if (value.type === 'custom-title') {
    return 'custom-title'
  }
  if (value.type === 'agent-color') {
    return 'agent-color'
  }
  if (value.type === 'system' && value.subtype === 'compact_boundary') {
    return 'compact_boundary'
  }
  const attachment = value.attachment
  if (
    value.type === 'attachment' &&
    attachment &&
    typeof attachment === 'object' &&
    (attachment as { type?: unknown }).type === 'goal_status'
  ) {
    return 'goal_status'
  }
  return null
}

function isEnqueueOf(value: Record<string, unknown>, name: string): boolean {
  if (value.type !== 'queue-operation' || value.operation !== 'enqueue') {
    return false
  }
  const content = typeof value.content === 'string' ? value.content.trimStart() : ''
  const head = `/${name}`
  return content === head || content.startsWith(`${head} `) || content.startsWith(`${head}\n`)
}

/**
 * Stage proved by transcript lines appended after the command was written. A record whose
 * `sessionId` is not one of `sessionIds` is ignored, and a torn line is skipped, never guessed.
 */
export function parseClaudeCommandReceipt(
  lines: readonly string[],
  name: string,
  sessionIds: ReadonlySet<string>
): { stage: TerminalCommandReceiptStage; record?: CommandReceiptRecord } {
  const expected = EXECUTED_RECORD_BY_COMMAND[name]
  let queued = false
  for (const raw of lines) {
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch {
      continue
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue
    }
    const record = value as Record<string, unknown>
    if (typeof record.sessionId !== 'string' || !sessionIds.has(record.sessionId)) {
      continue
    }
    if (expected && executedRecordOf(record) === expected) {
      return { stage: 'executed', record: expected }
    }
    if (isEnqueueOf(record, name)) {
      queued = true
    }
  }
  return queued ? { stage: 'queued', record: 'enqueue' } : { stage: 'input_accepted' }
}

async function openRegularTranscript(path: string) {
  let handle
  try {
    handle = await open(path, TRANSCRIPT_OPEN_FLAGS)
  } catch {
    return null
  }
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) {
      await handle.close()
      return null
    }
    return { handle, size: stat.size }
  } catch {
    await handle.close().catch(() => {})
    return null
  }
}

/** Size of the transcript, the offset a later read starts from; null when it cannot be read. */
export async function statClaudeTranscriptSize(path: string): Promise<number | null> {
  const opened = await openRegularTranscript(path)
  if (!opened) {
    return null
  }
  await opened.handle.close().catch(() => {})
  return opened.size
}

/**
 * Complete lines appended after `offset`. A trailing line without its newline is still being
 * written and is left for the next poll. Null means unreadable, which a caller reports as
 * `unverifiable`, never as "nothing happened".
 */
export async function readClaudeTranscriptSince(
  path: string,
  offset: number
): Promise<string[] | null> {
  const opened = await openRegularTranscript(path)
  if (!opened) {
    return null
  }
  try {
    const length = Math.min(Math.max(0, opened.size - offset), MAX_RECEIPT_READ_BYTES)
    if (length === 0) {
      return []
    }
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await opened.handle.read(buffer, 0, length, offset)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) {
      return []
    }
    return text
      .slice(0, lastNewline)
      .split('\n')
      .filter((entry) => entry.length > 0)
  } catch {
    return null
  } finally {
    await opened.handle.close().catch(() => {})
  }
}
