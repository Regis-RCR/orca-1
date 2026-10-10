import { ownRetainedString } from '../own-retained-string'
import { measureUtf8ByteLength } from '../utf8-byte-limits'
import { parseProgramStatusReport, type ProgramStatusParseResult } from './program-status-report'

/** Whole sequence, `ESC ]` through the terminator, in UTF-8 bytes. */
export const PROGRAM_STATUS_MAX_FRAME_BYTES = 4096

/** Offsets are raw sequence positions: `start` is the `ESC`, `end` is one past the last unit. */
export type ProgramStatusScanEvent =
  | { kind: 'report'; start: number; end: number; result: ProgramStatusParseResult }
  | { kind: 'prompt-start'; start: number; end: number }
  | { kind: 'reset'; start: number; end: number }

export type ProgramStatusScanSink = {
  /** Read before scanning and again after every event, so an event can arm the next one. */
  isResetArmed(): boolean
  isPromptStartArmed(): boolean
  onEvent(event: ProgramStatusScanEvent): void
}

export type ProgramStatusStreamScanner = {
  scan(data: string, rawStartSeq: number, sink: ProgramStatusScanSink): void
  /** Code units carried to the next chunk: a partial prefix or one open frame under the cap. */
  retainedCodeUnits(): number
}

const REPORT_PREFIX = '\x1b]7501;'
const PROMPT_START = '\x1b]133;A'
const RESET_SEQUENCE = '\x1bc'
const ESC = 0x1b
const BACKSLASH = 0x5c
const NOT_SEARCHED = -2
const MAX_FRAME = PROGRAM_STATUS_MAX_FRAME_BYTES

/** Forward-only search: a cached match (or absence) at or after `from` is still the first. */
function nextMatch(text: string, pattern: string, cached: number, from: number): number {
  return cached === NOT_SEARCHED || (cached !== -1 && cached < from)
    ? text.indexOf(pattern, from)
    : cached
}

/** Whether `text` from `from` to its end begins `pattern`, without a copy. */
function isPrefixAt(text: string, from: number, pattern: string): boolean {
  // Why no length check: a unit past the end of `pattern` reads NaN and never matches.
  for (let index = from; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== pattern.charCodeAt(index - from)) {
      return false
    }
  }
  return true
}

function utf8Bytes(text: string): number {
  // Why past the cap: `overCap` discounts a trailing ESC, so a stop at the cap reads as fitting.
  return measureUtf8ByteLength(text, { stopAfterBytes: MAX_FRAME + 1 }).byteLength
}

/** `ESC ] 133 ; A` is a prompt start when its terminator or a parameter follows. */
function endsPromptStart(code: number): boolean {
  return code === 0x07 || code === ESC || code === 0x3b
}

class StreamScanner implements ProgramStatusStreamScanner {
  private inFrame = false
  // Outside a frame: a partial prefix. In a frame: the frame so far, `null` once over the cap.
  private pending: string | null = ''
  private pendingStart = 0
  private pendingBytes = 0
  private lastUnit = 0
  private lastUnitSeq = 0
  // Length of the terminator `terminatorAt` found: BEL 1, ST 2, a bare ESC 0 (not consumed).
  private terminatorLength = 0
  // Position mapping for the text being scanned: a carried prefix, then the chunk.
  private carryLength = 0
  private chunkSeq = 0
  private nextBel = NOT_SEARCHED
  private nextEsc = NOT_SEARCHED

  retainedCodeUnits(): number {
    return this.pending?.length ?? 0
  }

  scan(data: string, rawStartSeq: number, sink: ProgramStatusScanSink): void {
    if (data.length === 0) {
      return
    }
    this.chunkSeq = rawStartSeq
    this.carryLength = 0
    this.nextBel = NOT_SEARCHED
    this.nextEsc = NOT_SEARCHED
    if (this.inFrame) {
      const resumeAt = this.continueFrame(data, sink)
      if (resumeAt === -1) {
        return
      }
      if (this.pending === '') {
        this.scanText(data, resumeAt, sink)
        return
      }
      // Otherwise a bare ESC that ended the last chunk closed the frame and is now the carry.
    }
    const carry = this.pending ?? ''
    this.carryLength = carry.length
    this.pending = ''
    this.scanText(carry.length === 0 ? data : carry + data, 0, sink)
  }

  private seqAt(index: number): number {
    return index < this.carryLength
      ? this.pendingStart + index
      : this.chunkSeq + index - this.carryLength
  }

  /**
   * Index of the first BEL or ESC at or after `from`, or -1 while undecided. An ESC is ST when
   * a backslash follows; otherwise it ends the frame unconsumed and starts the next sequence.
   */
  private terminatorAt(text: string, from: number): number {
    this.nextBel = nextMatch(text, '\x07', this.nextBel, from)
    this.nextEsc = nextMatch(text, '\x1b', this.nextEsc, from)
    if (this.nextEsc === -1 || (this.nextBel !== -1 && this.nextBel < this.nextEsc)) {
      this.terminatorLength = 1
      return this.nextBel
    }
    if (this.nextEsc + 1 === text.length) {
      return -1
    }
    this.terminatorLength = text.charCodeAt(this.nextEsc + 1) === BACKSLASH ? 2 : 0
    return this.nextEsc
  }

  private scanText(text: string, from: number, sink: ProgramStatusScanSink): void {
    let position = from
    let nextReport = NOT_SEARCHED
    let nextReset = NOT_SEARCHED
    let nextPrompt = NOT_SEARCHED
    for (;;) {
      // Re-read after every event: a report can arm RIS for the rest of this chunk.
      const resetArmed = sink.isResetArmed()
      const promptArmed = sink.isPromptStartArmed()
      nextReport = nextMatch(text, REPORT_PREFIX, nextReport, position)
      nextReset = resetArmed ? nextMatch(text, RESET_SEQUENCE, nextReset, position) : nextReset
      nextPrompt = promptArmed ? nextMatch(text, PROMPT_START, nextPrompt, position) : nextPrompt
      let at = nextReport
      if (resetArmed && nextReset !== -1 && (at === -1 || nextReset < at)) {
        at = nextReset
      }
      if (promptArmed && nextPrompt !== -1 && (at === -1 || nextPrompt < at)) {
        at = nextPrompt
      }
      if (at === -1) {
        this.carryTail(text, position, resetArmed, promptArmed)
        return
      }
      if (at === nextReport) {
        const close = this.terminatorAt(text, at + REPORT_PREFIX.length)
        if (close === -1) {
          this.openFrame(text, at)
          return
        }
        const end = close + this.terminatorLength
        this.emitFrame(text.slice(at, end), this.seqAt(at), this.seqAt(end), sink)
        position = end
      } else if (at === nextReset) {
        sink.onEvent({ kind: 'reset', start: this.seqAt(at), end: this.seqAt(at + 2) })
        position = at + 2
      } else {
        const after = at + PROMPT_START.length
        if (after === text.length) {
          this.keepPrefix(text, at)
          return
        }
        position = endsPromptStart(text.charCodeAt(after)) ? after : at + 1
        if (position === after) {
          sink.onEvent({ kind: 'prompt-start', start: this.seqAt(at), end: this.seqAt(after) })
        }
      }
    }
  }

  private carryTail(text: string, from: number, resetArmed: boolean, promptArmed: boolean): void {
    // Why a bounded window: every pattern starts with ESC and is at most this long.
    const windowStart = Math.max(from, text.length - PROMPT_START.length)
    for (let index = windowStart; index < text.length; index += 1) {
      if (
        text.charCodeAt(index) === ESC &&
        (isPrefixAt(text, index, REPORT_PREFIX) ||
          (resetArmed && isPrefixAt(text, index, RESET_SEQUENCE)) ||
          (promptArmed && isPrefixAt(text, index, PROMPT_START)))
      ) {
        this.keepPrefix(text, index)
        return
      }
    }
  }

  private keepPrefix(text: string, at: number): void {
    this.pendingStart = this.seqAt(at)
    this.pending = text.slice(at)
  }

  private openFrame(text: string, at: number): void {
    const rest = text.slice(at)
    this.inFrame = true
    this.pendingStart = this.seqAt(at)
    this.pendingBytes = utf8Bytes(rest)
    this.lastUnit = rest.charCodeAt(rest.length - 1)
    this.lastUnitSeq = this.seqAt(text.length - 1)
    this.pending = this.overCap() ? null : ownRetainedString(rest)
  }

  /** A trailing ESC may end the frame unconsumed, so it does not count yet. */
  private overCap(): boolean {
    return this.pendingBytes - (this.lastUnit === ESC ? 1 : 0) > MAX_FRAME
  }

  /** Resume an open frame; returns where scanning resumes in `data`, or -1. */
  private continueFrame(data: string, sink: ProgramStatusScanSink): number {
    const first = data.charCodeAt(0)
    const previous = this.lastUnit
    if (previous === ESC && first !== BACKSLASH) {
      // A bare trailing ESC: the frame ends before it, and it is carried to start the next one.
      this.terminatorLength = 0
      this.closeFrame(this.pending?.slice(0, -1) ?? null, this.lastUnitSeq, sink)
      this.pendingStart = this.lastUnitSeq
      this.pending = '\x1b'
      return 0
    }
    let end = 1
    if (previous === ESC) {
      this.terminatorLength = 2 // ST split across chunks
    } else {
      const close = this.terminatorAt(data, 0)
      end = close === -1 ? -1 : close + this.terminatorLength
    }
    const consumed = end === -1 ? data : data.slice(0, end)
    this.lastUnit = consumed.charCodeAt(consumed.length - 1)
    this.lastUnitSeq = this.chunkSeq + consumed.length - 1
    if (this.pending !== null) {
      // Why: the halves of a pair split across chunks count 3 + 3 bytes; together they are 4.
      const splitPair =
        previous >= 0xd800 && previous <= 0xdbff && first >= 0xdc00 && first <= 0xdfff
      this.pendingBytes += utf8Bytes(consumed) - (splitPair ? 2 : 0)
      this.pending = this.overCap() ? null : this.pending + ownRetainedString(consumed)
    }
    if (end === -1) {
      return -1
    }
    this.closeFrame(this.pending, this.chunkSeq + end, sink)
    return end
  }

  private closeFrame(frame: string | null, end: number, sink: ProgramStatusScanSink): void {
    this.inFrame = false
    this.pending = ''
    this.emitFrame(frame, this.pendingStart, end, sink)
  }

  /** `frame` is the sequence through its terminator, or `null` once it broke the cap. */
  private emitFrame(frame: string | null, start: number, end: number, sink: ProgramStatusScanSink) {
    if (frame === null || utf8Bytes(frame) > MAX_FRAME) {
      const result = { kind: 'discard', reason: 'frame-limit', skippedPairs: 0 } as const
      sink.onEvent({ kind: 'report', start, end, result })
      return
    }
    const body = frame.slice(REPORT_PREFIX.length, frame.length - this.terminatorLength)
    // Why: the probe body is answered by the PTY ingress, never reported.
    if (body !== '?') {
      sink.onEvent({ kind: 'report', start, end, result: parseProgramStatusReport(body) })
    }
  }
}

/**
 * Chunk-split-safe scanner for OSC 7501 reports, OSC 133;A prompt starts and RIS.
 * Why stateful per terminal: a PTY delivers sequences split at any byte, and only reports
 * are always scanned; RIS and prompt starts matter only while the caller holds records.
 */
export function createProgramStatusStreamScanner(): ProgramStatusStreamScanner {
  return new StreamScanner()
}
