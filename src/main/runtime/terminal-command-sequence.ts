import type { RuntimeTerminalAgentStatusState } from '../../shared/runtime-terminal-contracts'
import type { TerminalComposerState } from '../../shared/terminal-composer-draft'
import {
  buildTerminalCommandExpectedText,
  compareTerminalCommandDraft,
  type RuntimeTerminalCommand,
  type RuntimeTerminalCommandReceipt,
  type RuntimeTerminalCommandWrite,
  type TerminalCommandDraftCheck,
  type TerminalCommandErrorCode,
  type TerminalCommandReceiptStage,
  type TerminalCommandSelfTarget
} from '../../shared/terminal-command-contract'

export type TerminalCommandGuardReading =
  | { ok: true; agentStatus: RuntimeTerminalAgentStatusState; interactiveWait: string | null }
  | { ok: false; code: TerminalCommandErrorCode; message: string }

export type TerminalCommandReceiptReading = {
  stage: TerminalCommandReceiptStage
  record?: RuntimeTerminalCommandReceipt['record']
}

export type TerminalCommandSequenceDeps = {
  /** Agent kind, permission prompt and interactive wait, read fresh on every call. */
  checkGuards: () => Promise<TerminalCommandGuardReading>
  readComposer: () => Promise<TerminalComposerState>
  /** Raw bytes to the PTY; false when the terminal did not accept them. */
  write: (data: string) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
  now: () => number
  /** Absent when the session has no readable receipt source. */
  receipt?: {
    /** Pins the read offset before write 1; false when the source is unreadable. */
    start: () => Promise<boolean>
    /** Stage proved so far; null when the source became unreadable. */
    poll: () => Promise<TerminalCommandReceiptReading | null>
  }
}

export type TerminalCommandSequenceInput = {
  handle: string
  name: string
  args?: string
  requireDraft: boolean
  waitReceiptMs: number
  selfTarget: TerminalCommandSelfTarget
}

const SETTLE_TIMEOUT_MS = 1_000
const SETTLE_POLL_MS = 50
// Why: the gap measured sufficient between two CLI writes; used only when the draft is unobservable.
const SETTLE_UNOBSERVABLE_FLOOR_MS = 300
const RECEIPT_POLL_MS = 100
// Only these commands complete without a turn boundary, so a self-send can still see them execute.
const COMMANDS_EXECUTED_MID_TURN = new Set(['rename', 'color'])

const STAGE_RANK: Record<TerminalCommandReceiptStage, number> = {
  unverifiable: 0,
  input_accepted: 1,
  queued: 2,
  executed: 3
}

function draftOf(state: TerminalComposerState): string | null {
  if (state.state === 'unobservable') {
    return null
  }
  return state.state === 'text' ? state.text : ''
}

/**
 * The slash-command sequence: guards and an empty composer before write 1, raw writes with a
 * settle and a guard recheck before each next write, a draft check before the Enter, then an
 * optional receipt wait that never resends. Pure over `deps` so every refusal is testable.
 */
export async function runTerminalCommandSequence(
  input: TerminalCommandSequenceInput,
  deps: TerminalCommandSequenceDeps
): Promise<RuntimeTerminalCommand> {
  const writes: RuntimeTerminalCommandWrite[] = []
  const result: RuntimeTerminalCommand = {
    handle: input.handle,
    name: input.name,
    argsBytes: input.args ? Buffer.byteLength(input.args, 'utf8') : 0,
    selfTarget: input.selfTarget,
    writes,
    bytesWritten: 0
  }
  const refuse = (code: TerminalCommandErrorCode, message: string): RuntimeTerminalCommand => {
    result.refusal = { code, message }
    if (result.bytesWritten > 0) {
      result.stagedText = true
    }
    return result
  }

  const preflight = await deps.checkGuards()
  if (!preflight.ok) {
    return refuse(preflight.code, preflight.message)
  }
  const composer = await deps.readComposer()
  result.preflight = {
    agentStatus: preflight.agentStatus,
    composer: composer.state,
    interactiveWait: preflight.interactiveWait
  }
  if (composer.state === 'text') {
    return refuse('composer_not_empty', 'The composer holds staged text; no input was sent.')
  }
  if (composer.state === 'unobservable') {
    return refuse(
      'composer_not_observable',
      'The composer could not be read before the first write; no input was sent.'
    )
  }
  const receiptSourceReadable = deps.receipt ? await deps.receipt.start().catch(() => false) : false

  const chunks: { kind: RuntimeTerminalCommandWrite['kind']; data: string; expected: string }[] = [
    {
      kind: 'command',
      data: `/${input.name}`,
      expected: buildTerminalCommandExpectedText(input.name)
    }
  ]
  if (input.args) {
    chunks.push({
      kind: 'args',
      data: ` ${input.args}`,
      expected: buildTerminalCommandExpectedText(input.name, input.args)
    })
  }
  // Why: once a byte is written, any thrown read or write must still report the staged text,
  // so it becomes a refusal carrying the partial-write state instead of a transport error.
  const submit = async (): Promise<RuntimeTerminalCommand | null> => {
    for (const [index, chunk] of chunks.entries()) {
      if (index > 0) {
        const guard = await deps.checkGuards()
        if (!guard.ok) {
          return refuse(guard.code, `${guard.message} The Enter was withheld.`)
        }
      }
      const accepted = await deps.write(chunk.data)
      if (!accepted) {
        if (result.bytesWritten === 0) {
          throw new Error('terminal_not_writable')
        }
        return refuse(
          'agent_status_unknown',
          'The terminal stopped accepting input mid-sequence; the Enter was withheld.'
        )
      }
      const bytes = Buffer.byteLength(chunk.data, 'utf8')
      writes.push({ kind: chunk.kind, bytes })
      result.bytesWritten += bytes
      await settle(deps, chunk.expected)
    }

    const guard = await deps.checkGuards()
    if (!guard.ok) {
      return refuse(guard.code, `${guard.message} The Enter was withheld.`)
    }
    const expected = chunks.at(-1)!.expected
    const draftCheck: TerminalCommandDraftCheck = compareTerminalCommandDraft(
      draftOf(await deps.readComposer()),
      expected
    )
    result.draftCheck = draftCheck
    if (draftCheck === 'mismatch') {
      return refuse(
        'composer_not_empty',
        'The composer does not read back the typed command; the Enter was withheld.'
      )
    }
    if (draftCheck === 'unobservable' && input.requireDraft) {
      return refuse(
        'composer_not_observable',
        'The composer could not be read back and --require-draft is set; the Enter was withheld.'
      )
    }
    if (!(await deps.write('\r'))) {
      return refuse(
        'agent_status_unknown',
        'The terminal stopped accepting input before the Enter; the Enter was not written.'
      )
    }
    writes.push({ kind: 'submit', bytes: 1 })
    result.bytesWritten += 1
    return null
  }
  let withheld: RuntimeTerminalCommand | null
  try {
    withheld = await submit()
  } catch (error) {
    if (result.bytesWritten === 0) {
      throw error
    }
    const detail = error instanceof Error ? error.message : String(error)
    return refuse(
      'agent_status_unknown',
      `${detail} after input was written; the Enter was withheld.`
    )
  }
  if (withheld) {
    return withheld
  }

  try {
    result.receipt = await observeReceipt(input, deps, receiptSourceReadable)
  } catch {
    // The Enter is written; a failed receipt read is unverifiable, never a failed send.
    result.receipt = { stage: 'unverifiable', source: 'transcript' }
  }
  return result
}

async function settle(deps: TerminalCommandSequenceDeps, expected: string): Promise<void> {
  const deadline = deps.now() + SETTLE_TIMEOUT_MS
  while (true) {
    const check = compareTerminalCommandDraft(draftOf(await deps.readComposer()), expected)
    if (check === 'match') {
      return
    }
    if (check === 'unobservable') {
      await deps.sleep(SETTLE_UNOBSERVABLE_FLOOR_MS)
      return
    }
    if (deps.now() >= deadline) {
      return
    }
    await deps.sleep(SETTLE_POLL_MS)
  }
}

async function observeReceipt(
  input: TerminalCommandSequenceInput,
  deps: TerminalCommandSequenceDeps,
  sourceReadable: boolean
): Promise<RuntimeTerminalCommandReceipt> {
  if (!deps.receipt) {
    return { stage: 'unverifiable', source: 'none' }
  }
  if (!sourceReadable) {
    return { stage: 'unverifiable', source: 'transcript' }
  }
  // Why: a self-sent turn-boundary command cannot run before the caller's own turn ends.
  const ceiling: TerminalCommandReceiptStage =
    input.selfTarget === true && !COMMANDS_EXECUTED_MID_TURN.has(input.name) ? 'queued' : 'executed'
  const deadline = deps.now() + input.waitReceiptMs
  let best: TerminalCommandReceiptReading | null = null
  while (true) {
    const reading = await deps.receipt.poll()
    if (reading === null) {
      return best
        ? {
            stage: best.stage,
            source: 'transcript',
            ...(best.record ? { record: best.record } : {})
          }
        : { stage: 'unverifiable', source: 'transcript' }
    }
    if (!best || STAGE_RANK[reading.stage] > STAGE_RANK[best.stage]) {
      best = reading
    }
    const done = STAGE_RANK[best.stage] >= STAGE_RANK[ceiling]
    if (done || deps.now() >= deadline) {
      const stage = STAGE_RANK[best.stage] > STAGE_RANK[ceiling] ? ceiling : best.stage
      const record = stage === best.stage ? best.record : undefined
      return { stage, source: 'transcript', ...(record ? { record } : {}) }
    }
    await deps.sleep(RECEIPT_POLL_MS)
  }
}
