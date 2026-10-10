// Parser for the body of one OSC 7501 Program Status report (protocol rev 0.4).
// Why strict: every byte is untrusted program output, and the protocol requires a report
// that breaks a limit to be discarded whole before any stored record is touched.

export type ProgramStatusReportState = 'working' | 'blocked' | 'done' | 'error' | 'idle' | 'clear'
export type ProgramStatusBlockedKind = 'permission' | 'question' | 'auth'

export type ProgramStatusReport = {
  state: ProgramStatusReportState
  /** `null` addresses the root record. */
  id: string | null
  kind: ProgramStatusBlockedKind | null
  app: string | null
  progress: number | null
}

export type ProgramStatusDiscardReason =
  | 'frame-limit'
  | 'pair-limit'
  | 'base64'
  | 'control'
  | 'id'
  | 'state'

export type ProgramStatusParseResult =
  | { kind: 'report'; report: ProgramStatusReport; skippedPairs: number }
  | { kind: 'discard'; reason: ProgramStatusDiscardReason; skippedPairs: number }

const MAX_KEY_BYTES = 16
const MAX_APP_BYTES = 32
const MAX_ID_BYTES = 128
const MAX_ID_SEGMENT_BYTES = 32
const MAX_ID_LEVELS = 8
const ENCODED_TEXT_LIMITS = {
  msg: { encoded: 2732, decoded: 2048 },
  title: { encoded: 256, decoded: 192 }
} as const

const KEY_PATTERN = /^[a-z]+$/
const VALUE_PATTERN = /^[A-Za-z0-9_.,+/=-]*$/
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/
const APP_PATTERN = /^[A-Za-z0-9_.+-]{1,32}$/
const PROGRESS_PATTERN = /^[0-9]+$/
// Why ASCII only: a non-ASCII byte makes the pair malformed, so it must not be trimmed away.
const EDGE_WHITESPACE_PATTERN = /^[\t\n\v\f\r ]+|[\t\n\v\f\r ]+$/g

const RECOGNIZED_STATES: ReadonlySet<string> = new Set<ProgramStatusReportState>([
  'working',
  'blocked',
  'done',
  'error',
  'idle',
  'clear'
])
const RECOGNIZED_BLOCKED_KINDS: ReadonlySet<string> = new Set<ProgramStatusBlockedKind>([
  'permission',
  'question',
  'auth'
])

type Pair = { key: string; value: string }

function classifyPair(rawPair: string): Pair | null {
  const equals = rawPair.indexOf('=')
  if (equals === -1) {
    return null
  }
  const key = rawPair.slice(0, equals).replace(EDGE_WHITESPACE_PATTERN, '')
  const value = rawPair.slice(equals + 1).replace(EDGE_WHITESPACE_PATTERN, '')
  if (!KEY_PATTERN.test(key) || !VALUE_PATTERN.test(value)) {
    return null
  }
  return { key, value }
}

function stripPadding(value: string): string {
  return value.replace(/=+$/, '')
}

function decodeBase64Utf8(value: string): string | null {
  let binary: string
  try {
    binary = atob(value)
  } catch {
    return null
  }
  // Why: `atob` ignores non-zero trailing bits; strict base64 accepts only the canonical form.
  if (stripPadding(btoa(binary)) !== stripPadding(value)) {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  try {
    // Why ignoreBOM: a stripped leading BOM would escape the decoded size limit by three bytes.
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

function checkEncodedText(
  value: string,
  limits: { encoded: number; decoded: number }
): ProgramStatusDiscardReason | null {
  if (value.length > limits.encoded) {
    return 'pair-limit'
  }
  const decoded = decodeBase64Utf8(value)
  if (decoded === null) {
    return 'base64'
  }
  if (new TextEncoder().encode(decoded).byteLength > limits.decoded) {
    return 'pair-limit'
  }
  return hasControlCharacter(decoded) ? 'control' : null
}

/** C0, DEL or C1. */
function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index)
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true
    }
  }
  return false
}

function checkId(value: string): ProgramStatusDiscardReason | null {
  const segments = value.split('/')
  if (
    value.length > MAX_ID_BYTES ||
    segments.length > MAX_ID_LEVELS ||
    segments.some((segment) => segment.length > MAX_ID_SEGMENT_BYTES)
  ) {
    return 'pair-limit'
  }
  return segments.every((segment) => ID_SEGMENT_PATTERN.test(segment)) ? null : 'id'
}

/** Per-pair limits, applied to every well-formed occurrence before duplicates resolve. */
function checkPairLimits({ key, value }: Pair): ProgramStatusDiscardReason | null {
  if (key.length > MAX_KEY_BYTES) {
    return 'pair-limit'
  }
  switch (key) {
    case 'msg':
    case 'title':
      return checkEncodedText(value, ENCODED_TEXT_LIMITS[key])
    case 'app':
      return value.length > MAX_APP_BYTES ? 'pair-limit' : null
    case 'id':
      return checkId(value)
    default:
      return null
  }
}

/** Read only with `working` or `blocked`; any number of digits, value 0 to 100. */
function readProgress(state: ProgramStatusReportState, value: string | undefined): number | null {
  if ((state !== 'working' && state !== 'blocked') || !PROGRESS_PATTERN.test(value ?? '')) {
    return null
  }
  const progress = Number(value)
  return progress <= 100 ? progress : null
}

function isReportState(value: string | undefined): value is ProgramStatusReportState {
  return value !== undefined && RECOGNIZED_STATES.has(value)
}

function isBlockedKind(value: string | undefined): value is ProgramStatusBlockedKind {
  return value !== undefined && RECOGNIZED_BLOCKED_KINDS.has(value)
}

/** Parse the text between `ESC ] 7501 ;` and the terminator. The frame cap is the scanner's. */
export function parseProgramStatusReport(body: string): ProgramStatusParseResult {
  const pairs: Pair[] = []
  let skippedPairs = 0
  for (const rawPair of body.split(':')) {
    const pair = classifyPair(rawPair)
    if (pair === null) {
      skippedPairs += 1
    } else {
      pairs.push(pair)
    }
  }

  const resolved = new Map<string, string>()
  for (const pair of pairs) {
    const reason = checkPairLimits(pair)
    if (reason !== null) {
      return { kind: 'discard', reason, skippedPairs }
    }
    resolved.set(pair.key, pair.value)
  }

  const state = resolved.get('state')
  if (!isReportState(state)) {
    return { kind: 'discard', reason: 'state', skippedPairs }
  }
  const kind = resolved.get('kind')
  const app = resolved.get('app')
  return {
    kind: 'report',
    report: {
      state,
      id: resolved.get('id') ?? null,
      kind: state === 'blocked' && isBlockedKind(kind) ? kind : null,
      app: app !== undefined && APP_PATTERN.test(app) ? app : null,
      progress: readProgress(state, resolved.get('progress'))
    },
    skippedPairs
  }
}
