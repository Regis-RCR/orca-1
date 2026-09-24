import type { RuntimeTerminalAgentStatusState } from './runtime-terminal-contracts'

// Why: plugin commands (`plugin:name`) pass; anything that could carry a control byte, a space
// or a second slash is refused before a single byte reaches the PTY.
export const TERMINAL_COMMAND_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/

/** Upper bound for --wait-receipt, the same bound --wait-submit uses. */
export const TERMINAL_COMMAND_MAX_WAIT_RECEIPT_MS = 3_600_000

export const TERMINAL_COMMAND_RECEIPT_STAGES = [
  'input_accepted',
  'queued',
  'executed',
  'unverifiable'
] as const
export type TerminalCommandReceiptStage = (typeof TERMINAL_COMMAND_RECEIPT_STAGES)[number]

export const TERMINAL_COMMAND_ERROR_CODES = [
  'invalid_argument',
  'unsupported_agent',
  'agent_awaiting_permission',
  'agent_awaiting_answer',
  'composer_not_empty',
  'composer_not_observable',
  'agent_status_unknown',
  'incompatible_runtime'
] as const
export type TerminalCommandErrorCode = (typeof TERMINAL_COMMAND_ERROR_CODES)[number]

export type TerminalComposerReadState = 'empty' | 'text' | 'unobservable'
export type TerminalCommandDraftCheck = 'match' | 'mismatch' | 'unobservable'
export type TerminalCommandSelfTarget = boolean | 'unknown'

export type RuntimeTerminalCommandWrite = {
  kind: 'command' | 'args' | 'submit'
  bytes: number
}

export type RuntimeTerminalCommandReceipt = {
  stage: TerminalCommandReceiptStage
  source: 'transcript' | 'none'
  /** The transcript record that proved the stage, when one did. */
  record?: 'enqueue' | 'custom-title' | 'agent-color' | 'goal_status' | 'compact_boundary'
}

export type RuntimeTerminalCommandPreflight = {
  agentStatus: RuntimeTerminalAgentStatusState
  composer: TerminalComposerReadState
  interactiveWait: string | null
}

export type RuntimeTerminalCommand = {
  handle: string
  name: string
  argsBytes: number
  selfTarget: TerminalCommandSelfTarget
  writes: RuntimeTerminalCommandWrite[]
  bytesWritten: number
  preflight?: RuntimeTerminalCommandPreflight
  draftCheck?: TerminalCommandDraftCheck
  receipt?: RuntimeTerminalCommandReceipt
  /** Present on a refusal or a withheld Enter; absent when the Enter was written. */
  refusal?: { code: TerminalCommandErrorCode; message: string }
  /** True when bytes were written but the Enter was withheld, so text sits in the composer. */
  stagedText?: boolean
}

export function normalizeTerminalCommandName(raw: string): string | null {
  const name = raw.startsWith('/') ? raw.slice(1) : raw
  return TERMINAL_COMMAND_NAME_PATTERN.test(name) ? name : null
}

/** CR can submit and ESC can reframe the input halfway through; LF is allowed. */
export function validateTerminalCommandArgs(args: string): boolean {
  return !args.includes('\r') && !args.includes('\u001b')
}

export function buildTerminalCommandExpectedText(name: string, args?: string): string {
  return args ? `/${name} ${args}` : `/${name}`
}

/** The normalization the composer detector already applies to placeholder text. */
export function normalizeTerminalComposerText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export function compareTerminalCommandDraft(
  draft: string | null,
  expected: string
): TerminalCommandDraftCheck {
  if (draft === null) {
    return 'unobservable'
  }
  return normalizeTerminalComposerText(draft) === normalizeTerminalComposerText(expected)
    ? 'match'
    : 'mismatch'
}
