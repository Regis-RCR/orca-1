import { describe, expect, it } from 'vitest'
import {
  createProgramStatusStreamScanner,
  type ProgramStatusScanEvent,
  type ProgramStatusScanSink
} from './program-status-stream-scanner'

const ESC = '\x1b'
const BEL = '\x07'
const ST = '\x1b\\'

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function frame(body: string, terminator = BEL): string {
  return `${ESC}]7501;${body}${terminator}`
}

/**
 * Arms from a minimal model of the record store: RIS while any record exists, prompt-start
 * while a `working` or `blocked` record exists. The real store comes with the tracker.
 */
function createModelSink(arming: 'model' | 'always' | 'never' = 'model') {
  const states = new Map<string, string>()
  const events: ProgramStatusScanEvent[] = []
  const sink: ProgramStatusScanSink = {
    isResetArmed: () => (arming === 'model' ? states.size > 0 : arming === 'always'),
    isPromptStartArmed: () =>
      arming === 'model'
        ? [...states.values()].some((state) => state === 'working' || state === 'blocked')
        : arming === 'always',
    onEvent: (event) => {
      events.push(event)
      if (event.kind === 'reset') {
        states.clear()
      } else if (event.kind === 'prompt-start') {
        for (const [id, state] of states) {
          if (state === 'working' || state === 'blocked') {
            states.delete(id)
          }
        }
      } else if (event.result.kind === 'report') {
        const { id, state } = event.result.report
        const key = id ?? ''
        if (state !== 'clear') {
          states.set(key, state)
        } else {
          for (const existing of states.keys()) {
            if (key === '' || existing === key || existing.startsWith(`${key}/`)) {
              states.delete(existing)
            }
          }
        }
      }
    }
  }
  return { sink, events }
}

function scanChunks(
  chunks: string[],
  rawStartSeq = 1000,
  arming: 'model' | 'always' | 'never' = 'model'
) {
  const scanner = createProgramStatusStreamScanner()
  const { sink, events } = createModelSink(arming)
  let seq = rawStartSeq
  for (const chunk of chunks) {
    scanner.scan(chunk, seq, sink)
    seq += chunk.length
  }
  return { events, scanner }
}

function describeEvent(event: ProgramStatusScanEvent): string {
  if (event.kind !== 'report') {
    return event.kind
  }
  if (event.result.kind === 'discard') {
    return `discard:${event.result.reason}`
  }
  const { state, id } = event.result.report
  return id === null ? state : `${state}:${id}`
}

const CHILD = '0123456789abcdef0'

// Synthetic session shaped like a real agent CLI capture: key order, BEL terminators, a flat
// 17-hex child id, a probe, ordinary output, plus the ST, prompt and RIS cases the spec names.
const SESSION = [
  'shell output\r\n',
  frame('?'),
  `${ESC}[>0q${ESC}[?u${ESC}[c`,
  frame('state=idle:app=example-cli'),
  `${ESC}]133;A${BEL}`,
  frame('state=working:app=example-cli'),
  `some ${ESC}[1mbold${ESC}[0m output é ✓ \u{1f44b}\r\n`,
  frame(`state=blocked:app=example-cli:kind=permission:msg=${b64('approve a command')}`, ST),
  frame('state=working:app=example-cli'),
  frame(`state=working:app=example-cli:id=${CHILD}:title=${b64('a subtask')}`),
  frame(`state=clear:id=${CHILD}`),
  frame('state=done:app=example-cli'),
  frame(`state=done:app=example-cli:msg=${b64('finished')}`),
  `${ESC}]133;A;cl=m${ST}`,
  frame('state=working'),
  `${ESC}]133;A${BEL}prompt$ `,
  frame('state=idle'),
  `${ESC}[!p${ESC}[?1049h${ESC}[2J${ESC}[?1049l`,
  frame('state=paused'),
  `${ESC}c`,
  `${ESC}c`,
  frame('state=clear') + frame('state=clear')
].join('')

const SESSION_EVENTS = [
  'idle',
  'working',
  'blocked',
  'working',
  `working:${CHILD}`,
  `clear:${CHILD}`,
  'done',
  'done',
  'working',
  'prompt-start',
  'idle',
  'discard:state',
  'reset',
  'clear',
  'clear'
]

describe('program status stream scanner: frames', () => {
  it('reports BEL and ST frames with their source offsets', () => {
    const first = frame('state=working')
    const second = frame('state=done', ST)
    const { events } = scanChunks([`ab${first}cd${second}`], 500)
    expect(events).toEqual([
      {
        kind: 'report',
        start: 502,
        end: 502 + first.length,
        result: {
          kind: 'report',
          report: { state: 'working', id: null, kind: null, app: null, progress: null },
          skippedPairs: 0
        }
      },
      {
        kind: 'report',
        start: 504 + first.length,
        end: 504 + first.length + second.length,
        result: {
          kind: 'report',
          report: { state: 'done', id: null, kind: null, app: null, progress: null },
          skippedPairs: 0
        }
      }
    ])
  })

  it('ignores the probe body with either terminator', () => {
    expect(scanChunks([frame('?'), frame('?', ST)]).events).toEqual([])
  })

  it('forwards a discarded report as an event', () => {
    expect(scanChunks([frame('state=paused')]).events.map(describeEvent)).toEqual(['discard:state'])
  })

  it('ends a frame at a bare ESC, then scans that ESC as the next sequence', () => {
    const open = `${ESC}]7501;state=working`
    const { events } = scanChunks([`${open}${ESC}c:x=1${BEL}`], 0, 'always')
    expect(events).toEqual([
      {
        kind: 'report',
        start: 0,
        end: open.length,
        result: {
          kind: 'report',
          report: { state: 'working', id: null, kind: null, app: null, progress: null },
          skippedPairs: 0
        }
      },
      { kind: 'reset', start: open.length, end: open.length + 2 }
    ])
  })

  it.each([
    ['a new report', frame('state=done'), ['working', 'done']],
    ['a CSI sequence', `${ESC}[0m${BEL}`, ['working']],
    ['an armed prompt start', `${ESC}]133;A${BEL}`, ['working', 'prompt-start']]
  ])('ends a frame at a bare ESC that starts %s', (_label, next, expected) => {
    expect(scanChunks([`${ESC}]7501;state=working${next}`]).events.map(describeEvent)).toEqual(
      expected
    )
  })

  it('ignores a probe body ended by a bare ESC', () => {
    expect(scanChunks([`${ESC}]7501;?${ESC}[c`]).events).toEqual([])
  })

  it('decides an ESC at the end of a chunk from the next chunk', () => {
    const open = `${ESC}]7501;state=working`
    const bare = scanChunks([`${open}${ESC}`, 'c'], 0, 'always').events
    expect(bare.map(describeEvent)).toEqual(['working', 'reset'])
    expect(bare[0]).toMatchObject({ start: 0, end: open.length })
    expect(bare[1]).toEqual({ kind: 'reset', start: open.length, end: open.length + 2 })
    const st = scanChunks([`${open}${ESC}`, `\\${ESC}c`], 0, 'always').events
    expect(st.map(describeEvent)).toEqual(['working', 'reset'])
    expect(st[0]).toMatchObject({ start: 0, end: open.length + 2 })
  })

  it('carries an open frame under the cap until its terminator', () => {
    const scanner = createProgramStatusStreamScanner()
    const { sink, events } = createModelSink()
    scanner.scan(`x${ESC}]7501;state=wo`, 0, sink)
    expect(events).toEqual([])
    expect(scanner.retainedCodeUnits()).toBe(`${ESC}]7501;state=wo`.length)
    scanner.scan(`rking${BEL}tail`, 16, sink)
    expect(events.map(describeEvent)).toEqual(['working'])
    expect(events[0]).toMatchObject({ start: 1, end: 22 })
    expect(scanner.retainedCodeUnits()).toBe(0)
  })
})

describe('program status stream scanner: frame cap', () => {
  function fillTo(bytes: number, terminator = BEL): string {
    const fixed = Buffer.byteLength(frame('state=working:x=', terminator))
    return frame(`state=working:x=${'a'.repeat(bytes - fixed)}`, terminator)
  }

  it('accepts a frame of exactly 4096 bytes, BEL counted', () => {
    const sequence = fillTo(4096)
    expect(Buffer.byteLength(sequence)).toBe(4096)
    expect(scanChunks([sequence]).events.map(describeEvent)).toEqual(['working'])
  })

  it('counts the two bytes of ST', () => {
    const sequence = fillTo(4096).slice(0, -1) + ST
    expect(Buffer.byteLength(sequence)).toBe(4097)
    expect(scanChunks([sequence]).events.map(describeEvent)).toEqual(['discard:frame-limit'])
  })

  it('counts UTF-8 bytes, skipped pairs included', () => {
    const fixed = Buffer.byteLength(frame('state=working:y=e:x='))
    const ascii = frame(`state=working:y=e:x=${'a'.repeat(4096 - fixed)}`)
    const multiByte = ascii.replace('y=e', 'y=é')
    expect(Buffer.byteLength(ascii)).toBe(4096)
    expect(ascii.length).toBe(4096)
    expect(Buffer.byteLength(multiByte)).toBe(4097)
    expect(multiByte.length).toBe(4096)
    expect(scanChunks([ascii]).events).toMatchObject([{ result: { kind: 'report' } }])
    expect(scanChunks([multiByte]).events.map(describeEvent)).toEqual(['discard:frame-limit'])
  })

  it('discards conservatively when an undecodable byte arrived as U+FFFD, which counts three bytes', () => {
    // Why: the PTY decoder turns one invalid byte into U+FFFD, which is three UTF-8 bytes.
    const head = Buffer.from(`${ESC}]7501;state=working:y=`)
    const tail = Buffer.from(`:x=${'a'.repeat(4095 - head.length - 1 - 4)}${BEL}`)
    const raw = Buffer.concat([head, Buffer.from([0xff]), tail])
    expect(raw.length).toBe(4095)
    const decoded = raw.toString('utf8')
    expect(Buffer.byteLength(decoded)).toBe(4097)
    expect(scanChunks([decoded]).events.map(describeEvent)).toEqual(['discard:frame-limit'])
  })

  it('skips an oversized frame to its terminator without buffering it', () => {
    const scanner = createProgramStatusStreamScanner()
    const { sink, events } = createModelSink()
    let seq = 0
    const feed = (chunk: string) => {
      scanner.scan(chunk, seq, sink)
      seq += chunk.length
    }
    feed(`out${ESC}]7501;state=working:x=`)
    for (let index = 0; index < 100; index += 1) {
      feed('a'.repeat(1024))
      expect(scanner.retainedCodeUnits()).toBeLessThanOrEqual(4096)
    }
    expect(scanner.retainedCodeUnits()).toBe(0)
    expect(events).toEqual([])
    const end = seq + 1
    feed(`${BEL}${frame('state=done')}`)
    expect(events.map(describeEvent)).toEqual(['discard:frame-limit', 'done'])
    expect(events[0]).toMatchObject({ start: 3, end })
  })

  it('accepts 4096 bytes ended by a bare ESC, which is not counted', () => {
    const fixed = Buffer.byteLength(`${ESC}]7501;state=working:x=`)
    const sequence = `${ESC}]7501;state=working:x=${'a'.repeat(4096 - fixed)}`
    expect(Buffer.byteLength(sequence)).toBe(4096)
    const input = `${sequence}${ESC}[0m`
    const tooLong = `${sequence}a${ESC}[0m`
    for (let split = 4090; split <= input.length; split += 1) {
      const chunks = [input.slice(0, split), input.slice(split)].filter((chunk) => chunk !== '')
      expect(scanChunks(chunks).events.map(describeEvent), `split at ${split}`).toEqual(['working'])
      const over = [tooLong.slice(0, split), tooLong.slice(split)].filter((chunk) => chunk !== '')
      expect(scanChunks(over).events.map(describeEvent), `split at ${split}`).toEqual([
        'discard:frame-limit'
      ])
    }
  })

  it('ends an oversized frame at a bare ESC while skipping', () => {
    const { events } = scanChunks(
      [`${ESC}]7501;state=working:x=${'a'.repeat(5000)}`, `${ESC}c${frame('state=done')}`],
      0,
      'always'
    )
    expect(events.map(describeEvent)).toEqual(['discard:frame-limit', 'reset', 'done'])
  })

  it.each([
    ['ST', '\\', ['discard:frame-limit', 'done']],
    ['BEL after a bare ESC', BEL, ['discard:frame-limit', 'done']],
    ['a bare ESC', 'c', ['discard:frame-limit', 'reset', 'done']]
  ])(
    'retains nothing for an oversized frame whose chunk ends in ESC, then resumes on %s',
    (_name, resume, expected) => {
      for (const opened of ['', `${ESC}]7501;state=working:x=`]) {
        const scanner = createProgramStatusStreamScanner()
        const { sink, events } = createModelSink('always')
        const oversized = `${opened === '' ? `${ESC}]7501;state=working:x=` : ''}${'a'.repeat(100_000)}`
        if (opened !== '') {
          scanner.scan(opened, 0, sink)
        }
        scanner.scan(`${oversized}${ESC}`, opened.length, sink)
        expect(scanner.retainedCodeUnits()).toBe(0)
        scanner.scan(`${resume}${frame('state=done')}`, opened.length + oversized.length + 1, sink)
        expect(events.map(describeEvent)).toEqual(expected)
        expect(scanner.retainedCodeUnits()).toBe(0)
      }
    }
  )

  it('finds an ST split across chunks while skipping', () => {
    const { events } = scanChunks([
      `${ESC}]7501;state=working:x=${'a'.repeat(5000)}${ESC}`,
      `\\${frame('state=done')}`
    ])
    expect(events.map(describeEvent)).toEqual(['discard:frame-limit', 'done'])
  })
})

describe('program status stream scanner: RIS', () => {
  it('ignores RIS while no record exists', () => {
    expect(scanChunks([`${ESC}c`]).events).toEqual([])
  })

  it('arms RIS from a record created earlier in the same chunk', () => {
    const { events } = scanChunks([`${ESC}c${frame('state=done')}text${ESC}c`])
    expect(events.map(describeEvent)).toEqual(['done', 'reset'])
    expect(events[1]).toMatchObject({ kind: 'reset' })
  })

  it('arms RIS from a record created in an earlier chunk', () => {
    expect(scanChunks([frame('state=done'), `x${ESC}c`]).events.map(describeEvent)).toEqual([
      'done',
      'reset'
    ])
  })

  it('reports RIS split between ESC and c', () => {
    const { events } = scanChunks([`${frame('state=done')}${ESC}`, 'c'], 0)
    expect(events.map(describeEvent)).toEqual(['done', 'reset'])
    const resetStart = frame('state=done').length
    expect(events[1]).toEqual({ kind: 'reset', start: resetStart, end: resetStart + 2 })
  })

  it('does not treat DECSTR, alternate screen or erase display as a reset', () => {
    const { events } = scanChunks([
      frame('state=done'),
      `${ESC}[!p${ESC}[?1049h${ESC}[?47h${ESC}[?1047l${ESC}[2J${ESC}[?1049l`
    ])
    expect(events.map(describeEvent)).toEqual(['done'])
  })
})

describe('program status stream scanner: prompt start', () => {
  it('ignores OSC 133;A while no working or blocked record exists', () => {
    expect(
      scanChunks([frame('state=done'), `${ESC}]133;A${BEL}`]).events.map(describeEvent)
    ).toEqual(['done'])
  })

  it.each([
    ['BEL', `${ESC}]133;A${BEL}`],
    ['ST', `${ESC}]133;A${ST}`],
    ['parameters', `${ESC}]133;A;cl=m;aid=7${BEL}`]
  ])('reports a prompt start terminated by %s', (_label, sequence) => {
    const { events } = scanChunks([frame('state=working'), sequence], 0)
    expect(events.map(describeEvent)).toEqual(['working', 'prompt-start'])
    const start = frame('state=working').length
    expect(events[1]).toEqual({ kind: 'prompt-start', start, end: start + sequence.length })
  })

  it.each([
    ['a bare parameter separator', [`${ESC}]133;A;`]],
    ['parameters', [`${ESC}]133;A;cl=m;aid=7`]],
    ['parameters, then output', [`${ESC}]133;A;cl=m`, '\r\nmore output ']]
  ])('reports nothing for a prompt start with %s and no terminator', (_label, chunks) => {
    const { events, scanner } = scanChunks([frame('state=working'), ...chunks])
    expect(events.map(describeEvent)).toEqual(['working'])
    expect(scanner.retainedCodeUnits()).toBeLessThanOrEqual(4096)
  })

  it.each([
    ['RIS', `${ESC}c`, ['working', 'reset']],
    ['a report', frame('state=done'), ['working', 'done']],
    ['a CSI sequence', `${ESC}[0m`, ['working']]
  ])('reports no prompt start ended by a bare ESC that starts %s', (_label, next, expected) => {
    for (const open of [`${ESC}]133;A`, `${ESC}]133;A;cl=m`]) {
      const input = `${frame('state=working')}${open}${next}`
      expect(scanChunks([input]).events.map(describeEvent), open).toEqual(expected)
      expect(scanChunks(input.split('')).events.map(describeEvent), open).toEqual(expected)
    }
  })

  it.each([
    ['BEL', BEL],
    ['ST', ST]
  ])('reports a prompt start once its %s arrives, whatever the chunk split', (_label, end) => {
    const sequence = `${ESC}]133;A;cl=m;aid=7${end}`
    const input = `${frame('state=working')}${sequence}prompt$ `
    const start = frame('state=working').length
    const expected = [
      { kind: 'prompt-start', start, end: start + sequence.length }
    ] satisfies ProgramStatusScanEvent[]
    for (let split = 1; split < input.length; split += 1) {
      const { events } = scanChunks([input.slice(0, split), input.slice(split)], 0)
      expect(events.slice(1), `split at ${split}`).toEqual(expected)
    }
    expect(scanChunks(input.split(''), 0).events.slice(1)).toEqual(expected)
  })

  it('accepts a prompt start of exactly 4096 bytes and drops a longer one', () => {
    const head = `${ESC}]133;A;x=`
    const fits = `${head}${'a'.repeat(4096 - head.length - 1)}${BEL}`
    expect(Buffer.byteLength(fits)).toBe(4096)
    const over = `${head}a${fits.slice(head.length)}`
    expect(scanChunks([frame('state=working'), fits]).events.map(describeEvent)).toEqual([
      'working',
      'prompt-start'
    ])
    expect(scanChunks([frame('state=working'), over]).events.map(describeEvent)).toEqual([
      'working'
    ])
  })

  it('drops an over-long unterminated prompt start within the frame bound', () => {
    const scanner = createProgramStatusStreamScanner()
    const { sink, events } = createModelSink()
    let seq = 0
    const feed = (chunk: string) => {
      scanner.scan(chunk, seq, sink)
      seq += chunk.length
    }
    feed(`${frame('state=working')}${ESC}]133;A;`)
    for (let index = 0; index < 100; index += 1) {
      feed('a'.repeat(1024))
      expect(scanner.retainedCodeUnits()).toBeLessThanOrEqual(4096)
    }
    expect(scanner.retainedCodeUnits()).toBe(0)
    feed(`${BEL}${frame('state=done')}`)
    expect(events.map(describeEvent)).toEqual(['working', 'done'])
  })

  it('does not report OSC 133;B or a longer command letter', () => {
    const { events } = scanChunks([
      frame('state=blocked'),
      `${ESC}]133;B${BEL}${ESC}]133;AB${BEL}${ESC}]1337;A${BEL}`
    ])
    expect(events.map(describeEvent)).toEqual(['blocked'])
  })

  it('disarms itself once the prompt start dropped the active record', () => {
    const { events } = scanChunks([`${frame('state=working')}${ESC}]133;A${BEL}${ESC}]133;A${BEL}`])
    expect(events.map(describeEvent)).toEqual(['working', 'prompt-start'])
  })
})

describe('program status stream scanner: chunk splits', () => {
  it('reads the synthetic session as expected', () => {
    expect(scanChunks([SESSION]).events.map(describeEvent)).toEqual(SESSION_EVENTS)
  })

  it('yields identical events for every two-way split', () => {
    const whole = scanChunks([SESSION]).events
    for (let split = 1; split < SESSION.length; split += 1) {
      const { events } = scanChunks([SESSION.slice(0, split), SESSION.slice(split)])
      expect(events, `split at ${split}`).toEqual(whole)
    }
  })

  it('yields identical events one code unit at a time', () => {
    const whole = scanChunks([SESSION]).events
    const units = SESSION.split('')
    expect(scanChunks(units).events).toEqual(whole)
  })

  it('yields identical events for an oversized frame split around both of its ends', () => {
    const big = `${ESC}]7501;state=working:x=${'a'.repeat(4200)}${ST}`
    const input = `ab${frame('state=done')}${big}${frame('state=idle')}${ESC}c`
    const whole = scanChunks([input]).events
    expect(whole.map(describeEvent)).toEqual(['done', 'discard:frame-limit', 'idle', 'reset'])
    const bigStart = input.indexOf(big)
    const bigEnd = bigStart + big.length
    const splits = [
      ...Array.from({ length: 30 }, (_, index) => bigStart - 10 + index),
      ...Array.from({ length: 30 }, (_, index) => bigStart + 4080 + index),
      ...Array.from({ length: 30 }, (_, index) => bigEnd - 15 + index)
    ]
    for (const split of splits) {
      const { events } = scanChunks([input.slice(0, split), input.slice(split)])
      expect(events, `split at ${split}`).toEqual(whole)
    }
  })

  it('yields identical events around bare ESC terminators for every split', () => {
    const input = [
      'out ',
      `${ESC}]7501;state=working:app=example-cli${ESC}[1mbold `,
      `${ESC}]7501;state=blocked:kind=question${frame('state=working')}`,
      `${ESC}]7501;?${ESC}[c`,
      `${ESC}]7501;state=working${ESC}]133;A${BEL}`,
      `${ESC}]7501;state=done${ESC}c`,
      `${ESC}]7501;state=idle${ST}`,
      `${ESC}]7501;state=working:x=${'a'.repeat(4200)}${ESC}[0m tail`
    ].join('')
    const whole = scanChunks([input]).events
    expect(whole.map(describeEvent)).toEqual([
      'working',
      'blocked',
      'working',
      'working',
      'prompt-start',
      'done',
      'reset',
      'idle',
      'discard:frame-limit'
    ])
    for (let split = 1; split < input.length; split += 1) {
      const { events } = scanChunks([input.slice(0, split), input.slice(split)])
      expect(events, `split at ${split}`).toEqual(whole)
    }
    expect(scanChunks(input.split('')).events).toEqual(whole)
  })

  it('keeps a surrogate pair split across chunks at its exact byte count', () => {
    const fixed = Buffer.byteLength(frame('state=working:y=\u{1f44b}:x='))
    const sequence = frame(`state=working:y=\u{1f44b}:x=${'a'.repeat(4096 - fixed)}`)
    expect(Buffer.byteLength(sequence)).toBe(4096)
    const pair = sequence.indexOf('\u{1f44b}')
    const { events } = scanChunks([sequence.slice(0, pair + 1), sequence.slice(pair + 1)])
    expect(events).toMatchObject([{ result: { kind: 'report', skippedPairs: 1 } }])
  })

  it('carries at most a partial prefix between chunks', () => {
    const scanner = createProgramStatusStreamScanner()
    const { sink } = createModelSink('always')
    scanner.scan(`text${ESC}]750`, 0, sink)
    expect(scanner.retainedCodeUnits()).toBe(5)
    scanner.scan(`x plain`, 9, sink)
    expect(scanner.retainedCodeUnits()).toBe(0)
    scanner.scan(`text${ESC}]133;A`, 16, sink)
    expect(scanner.retainedCodeUnits()).toBe(7)
    scanner.scan(`plain ending in 1`, 27, sink)
    expect(scanner.retainedCodeUnits()).toBe(0)
  })
})
