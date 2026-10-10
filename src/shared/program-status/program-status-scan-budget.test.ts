import { describe, expect, it, vi } from 'vitest'
import {
  createProgramStatusStreamScanner,
  type ProgramStatusScanEvent,
  type ProgramStatusScanSink
} from './program-status-stream-scanner'

const ESC = '\x1b'
const BEL = '\x07'

function sinkWith(armed: boolean): {
  sink: ProgramStatusScanSink
  events: ProgramStatusScanEvent[]
} {
  const events: ProgramStatusScanEvent[] = []
  return {
    events,
    sink: {
      isResetArmed: () => armed,
      isPromptStartArmed: () => armed,
      onEvent: (event) => events.push(event)
    }
  }
}

/** Characters swept by `indexOf` and read by `charCodeAt`, on any string, across the feed. */
function feedWithScanBudget(chunks: string[], armed: boolean) {
  let searchedChars = 0
  const indexOf = String.prototype.indexOf
  const charCodeAt = String.prototype.charCodeAt
  const indexOfSpy = vi.spyOn(String.prototype, 'indexOf').mockImplementation(function (
    this: string,
    search,
    from = 0
  ) {
    const found = indexOf.call(this, search, from)
    searchedChars += (found === -1 ? this.length : found + String(search).length) - Number(from)
    return found
  })
  const charCodeAtSpy = vi.spyOn(String.prototype, 'charCodeAt').mockImplementation(function (
    this: string,
    index
  ) {
    searchedChars += 1
    return charCodeAt.call(this, index)
  })
  const scanner = createProgramStatusStreamScanner()
  const { sink, events } = sinkWith(armed)
  try {
    let seq = 0
    for (const chunk of chunks) {
      scanner.scan(chunk, seq, sink)
      seq += chunk.length
    }
  } finally {
    indexOfSpy.mockRestore()
    charCodeAtSpy.mockRestore()
  }
  return { events, searchedChars, scanner }
}

function chunksOf(data: string, size: number): string[] {
  const chunks: string[] = []
  for (let index = 0; index < data.length; index += size) {
    chunks.push(data.slice(index, index + size))
  }
  return chunks
}

// Why 6: one forward pass per pattern (report prefix, RIS, prompt start), one per terminator
// (BEL, ST) and one byte count over each frame. Re-scanning would grow with the data instead.
const PASSES = 6

describe('OSC 7501 scan budget', () => {
  it('reads 10 MiB of mixed output and reports in 64 KiB chunks forward only', () => {
    const line = `output ${ESC}[32mcolor${ESC}[0m text é\r\n`
    const block = `${line.repeat(40)}${ESC}]7501;state=working:app=example-cli${BEL}${ESC}]133;A${BEL}`
    const data = block.repeat(Math.ceil((10 * 1024 * 1024) / block.length))
    const blocks = data.length / block.length

    const { events, searchedChars } = feedWithScanBudget(chunksOf(data, 64 * 1024), true)

    expect(events).toHaveLength(blocks * 2)
    expect(events.filter((event) => event.kind === 'prompt-start')).toHaveLength(blocks)
    expect(searchedChars).toBeLessThanOrEqual(data.length * PASSES)
  })

  it('scans 10 000 reports in one chunk forward only, in order', () => {
    const states = ['working', 'blocked', 'done', 'idle'] as const
    const data = Array.from(
      { length: 10_000 },
      (_, index) => `${ESC}]7501;state=${states[index % states.length]}${BEL}`
    ).join('')

    const { events, searchedChars } = feedWithScanBudget([data], true)

    expect(events).toHaveLength(10_000)
    expect(
      events.every(
        (event, index) =>
          event.kind === 'report' &&
          event.result.kind === 'report' &&
          event.result.report.state === states[index % states.length]
      )
    ).toBe(true)
    expect(searchedChars).toBeLessThanOrEqual(data.length * PASSES)
  })

  it.each([
    ['only the report arm', false, 1],
    ['every arm', true, 3]
  ])('costs one indexOf per active arm on a miss with %s', (_label, armed, arms) => {
    const data = `plain ${ESC}[1mstyled${ESC}[0m output ${ESC}]0;title${BEL}\r\n`.repeat(2000)

    const { events, searchedChars, scanner } = feedWithScanBudget([data], armed)

    expect(events).toEqual([])
    expect(scanner.retainedCodeUnits()).toBe(0)
    // Plus at most the seven code units of the tail check.
    expect(searchedChars).toBeLessThanOrEqual(data.length * arms + 7)
  })

  it('does not copy or split the chunk on a miss', () => {
    const data = `plain ${ESC}[1mstyled${ESC}[0m output\r\n`.repeat(2000)
    const touched: string[] = []
    const spies = (['slice', 'substring', 'split', 'concat'] as const).map((method) => ({
      method,
      spy: vi.spyOn(String.prototype, method)
    }))
    const scanner = createProgramStatusStreamScanner()
    const { sink, events } = sinkWith(true)
    try {
      scanner.scan(data, 0, sink)
    } finally {
      // Why contexts: each spy records the string it was called on; restoring clears them.
      for (const { method, spy } of spies) {
        for (const context of spy.mock.contexts) {
          if (context === data) {
            touched.push(method)
          }
        }
        spy.mockRestore()
      }
    }
    expect(events).toEqual([])
    expect(touched).toEqual([])
  })

  it('keeps per-chunk work flat while an open frame accumulates', () => {
    const feedOf = (chunkCount: number): string[] => [
      `${ESC}]7501;state=working:x=`,
      ...Array<string>(chunkCount).fill('a')
    ]

    const small = feedWithScanBudget(feedOf(1500), true)
    const large = feedWithScanBudget(feedOf(3000), true)

    expect(small.events).toEqual([])
    expect(large.scanner.retainedCodeUnits()).toBeGreaterThan(3000)
    // Re-scanning the accumulation would quadruple the budget when the feed doubles.
    expect(large.searchedChars).toBeLessThan(small.searchedChars * 3)
  })

  it('keeps per-chunk work flat while an oversized frame is skipped', () => {
    const feedOf = (chunkCount: number): string[] => [
      `${ESC}]7501;state=working:x=${'a'.repeat(5000)}`,
      ...Array<string>(chunkCount).fill('a')
    ]

    const small = feedWithScanBudget(feedOf(20_000), true)
    const large = feedWithScanBudget(feedOf(40_000), true)

    expect(large.scanner.retainedCodeUnits()).toBe(0)
    expect(large.searchedChars).toBeLessThan(small.searchedChars * 3)
  })
})
