import { describe, expect, it } from 'vitest'
import { parseProgramStatusReport } from './program-status-report'

function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function b64Bytes(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64')
}

function report(body: string) {
  const result = parseProgramStatusReport(body)
  if (result.kind !== 'report') {
    throw new Error(`expected a report, got discard ${result.reason}`)
  }
  return result
}

describe('parseProgramStatusReport: accepted reports', () => {
  it.each(['working', 'blocked', 'done', 'error', 'idle', 'clear'] as const)(
    'accepts the recognized state %s for the root',
    (state) => {
      expect(parseProgramStatusReport(`state=${state}`)).toEqual({
        kind: 'report',
        report: { state, id: null, kind: null, app: null, progress: null },
        skippedPairs: 0
      })
    }
  )

  it('reads the shapes an agent CLI emits, in its key order', () => {
    expect(report('state=idle:app=example-cli').report).toEqual({
      state: 'idle',
      id: null,
      kind: null,
      app: 'example-cli',
      progress: null
    })
    expect(
      report(`state=blocked:app=example-cli:kind=permission:msg=${b64('approve a command')}`).report
    ).toEqual({
      state: 'blocked',
      id: null,
      kind: 'permission',
      app: 'example-cli',
      progress: null
    })
    expect(
      report(`state=working:app=example-cli:id=0123456789abcdef0:title=${b64('a subtask')}`).report
    ).toMatchObject({ state: 'working', id: '0123456789abcdef0' })
    expect(report('state=clear:id=0123456789abcdef0').report).toMatchObject({
      state: 'clear',
      id: '0123456789abcdef0'
    })
  })

  it('removes whitespace around keys and values', () => {
    expect(report(' state = working :\tapp\t=\texample-cli ').report).toMatchObject({
      state: 'working',
      app: 'example-cli'
    })
  })

  it('removes every ASCII whitespace byte around keys and values, and nothing else', () => {
    expect(report('\n\u000b\fstate\r= working\r\n:app=\u000bexample-cli\f').report).toMatchObject({
      state: 'working',
      app: 'example-cli'
    })
    expect(parseProgramStatusReport('state=working:app=\u00a0example-cli')).toEqual({
      kind: 'report',
      report: { state: 'working', id: null, kind: null, app: null, progress: null },
      skippedPairs: 1
    })
  })

  it('does not retain the decoded msg or title', () => {
    const parsed = report(`state=done:msg=${b64('summary')}:title=${b64('title')}`)
    expect(Object.keys(parsed.report).sort()).toEqual(['app', 'id', 'kind', 'progress', 'state'])
  })

  it('accepts an empty msg and an unpadded msg', () => {
    expect(report('state=done:msg=').report.state).toBe('done')
    expect(report('state=done:msg=QQ').report.state).toBe('done')
    expect(report('state=done:msg=QQ==').report.state).toBe('done')
    expect(report('state=done:msg=QUI').report.state).toBe('done')
    expect(report('state=done:msg=QUI=').report.state).toBe('done')
  })
})

describe('parseProgramStatusReport: malformed pairs are skipped', () => {
  it.each([
    ['no equals sign', 'state=working:junk', 1],
    ['an empty key', 'state=working:=value', 1],
    ['an uppercase key', 'state=working:App=example', 1],
    ['a key byte outside a-z', 'state=working:ap1=example', 1],
    ['a value byte outside the set', 'state=working:app=exa mple', 1],
    ['a non-ASCII value', 'state=working:x=é', 1],
    ['a U+FFFD value', 'state=working:x=�', 1],
    ['an empty trailing pair', 'state=working:', 1],
    ['two malformed pairs', 'junk:state=working:also junk', 2]
  ])('skips %s and keeps the report', (_label, body, skippedPairs) => {
    expect(parseProgramStatusReport(body)).toEqual({
      kind: 'report',
      report: { state: 'working', id: null, kind: null, app: null, progress: null },
      skippedPairs
    })
  })

  it('skips a malformed pair whatever its size', () => {
    const key = 'abcdefghijklmnopqr'
    expect(key).toHaveLength(18)
    expect(parseProgramStatusReport(`state=working:${key}=é`)).toMatchObject({
      kind: 'report',
      skippedPairs: 1
    })
  })

  it('does not let a malformed later duplicate override a well-formed state', () => {
    expect(parseProgramStatusReport('state=done:state=wor king')).toMatchObject({
      kind: 'report',
      report: { state: 'done' },
      skippedPairs: 1
    })
  })

  it('counts skipped pairs on a discard too', () => {
    expect(parseProgramStatusReport('junk:also junk')).toEqual({
      kind: 'discard',
      reason: 'state',
      skippedPairs: 2
    })
  })
})

describe('parseProgramStatusReport: unknown keys and key length', () => {
  it('ignores an unknown key of 16 bytes', () => {
    expect(report('state=working:abcdefghijklmnop=1').report.state).toBe('working')
  })

  it('discards a well-formed 17-byte key, known or unknown', () => {
    expect(parseProgramStatusReport('state=working:abcdefghijklmnopq=1')).toEqual({
      kind: 'discard',
      reason: 'pair-limit',
      skippedPairs: 0
    })
  })
})

describe('parseProgramStatusReport: duplicates', () => {
  it('lets the last well-formed occurrence win', () => {
    expect(report('state=working:state=done').report.state).toBe('done')
    expect(report('state=working:app=one:app=two').report.app).toBe('two')
  })

  it('checks every occurrence before resolving duplicates', () => {
    const oversized = 'A'.repeat(2736)
    expect(parseProgramStatusReport(`state=done:msg=${oversized}:msg=${b64('ok')}`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
    expect(parseProgramStatusReport(`state=done:msg=a-b:msg=${b64('ok')}`)).toMatchObject({
      kind: 'discard',
      reason: 'base64'
    })
    expect(parseProgramStatusReport(`state=done:id=${'x'.repeat(33)}:id=a`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
    expect(parseProgramStatusReport(`state=done:app=${'a'.repeat(33)}:app=ok`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
  })

  // Why: the id grammar decides which record a report addresses, which only the last value does.
  it('checks the id grammar on the last occurrence only', () => {
    expect(report('state=done:id=a//b:id=a').report.id).toBe('a')
    expect(report('state=done:id=:id=a/b').report.id).toBe('a/b')
    expect(parseProgramStatusReport('state=done:id=a:id=a//b')).toMatchObject({
      kind: 'discard',
      reason: 'id'
    })
  })
})

describe('parseProgramStatusReport: msg and title limits', () => {
  it('accepts msg at 2732 encoded bytes and 2048 decoded bytes', () => {
    const encoded = b64('a'.repeat(2048))
    expect(encoded).toHaveLength(2732)
    expect(report(`state=done:msg=${encoded}`).report.state).toBe('done')
  })

  it('checks the encoded msg length before decoding', () => {
    // Why: 2733 'A's is not decodable base64, so pair-limit proves the order.
    expect(parseProgramStatusReport(`state=done:msg=${'A'.repeat(2733)}`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
  })

  it('discards a msg that decodes past 2048 bytes', () => {
    const encoded = b64('a'.repeat(2049))
    expect(encoded).toHaveLength(2732)
    expect(parseProgramStatusReport(`state=done:msg=${encoded}`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
  })

  it('counts decoded bytes, not characters', () => {
    const encoded = b64(`a${'é'.repeat(1024)}`)
    expect(encoded).toHaveLength(2732)
    expect(Buffer.from(encoded, 'base64')).toHaveLength(2049)
    expect(parseProgramStatusReport(`state=done:msg=${encoded}`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
  })

  it('counts a leading UTF-8 byte order mark in the decoded size', () => {
    const fits = b64(`\ufeff${'a'.repeat(2045)}`)
    expect(Buffer.from(fits, 'base64')).toHaveLength(2048)
    expect(report(`state=done:msg=${fits}`).report.state).toBe('done')
    const encoded = b64(`\ufeff${'a'.repeat(2046)}`)
    expect(encoded).toHaveLength(2732)
    expect(Buffer.from(encoded, 'base64')).toHaveLength(2049)
    for (const body of [
      `state=done:msg=${encoded}`,
      `state=done:msg=${encoded}:msg=${b64('ok')}`
    ]) {
      expect(parseProgramStatusReport(body)).toMatchObject({
        kind: 'discard',
        reason: 'pair-limit'
      })
    }
  })

  it('applies the 256-byte encoded limit to title (192 decoded is its exact image)', () => {
    expect(report(`state=working:title=${b64('t'.repeat(192))}`).report.state).toBe('working')
    expect(parseProgramStatusReport(`state=working:title=${b64('t'.repeat(193))}`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
    expect(parseProgramStatusReport(`state=working:title=${'A'.repeat(257)}`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
  })

  it.each([
    ['a byte outside the base64 alphabet', 'a-b_'],
    ['a dot', 'QQ.='],
    ['a length of 1 mod 4', 'QUJDR'],
    ['padding on a length that is not a multiple of 4', 'QQ='],
    ['padding in the middle', 'QQ==QQ=='],
    ['three padding characters', 'Q==='],
    ['non-zero trailing bits after one byte, padded', 'QR=='],
    ['non-zero trailing bits after one byte, unpadded', 'QR'],
    ['non-zero trailing bits after two bytes, padded', 'QUJ='],
    ['non-zero trailing bits after two bytes, unpadded', 'QUJ'],
    ['bytes that are not UTF-8', b64Bytes([0xff, 0xfe])],
    ['a truncated UTF-8 sequence', b64Bytes([0xc3])]
  ])('discards msg with %s as base64', (_label, value) => {
    expect(parseProgramStatusReport(`state=done:msg=${value}`)).toMatchObject({
      kind: 'discard',
      reason: 'base64'
    })
    expect(parseProgramStatusReport(`state=done:title=${value}`)).toMatchObject({
      kind: 'discard',
      reason: 'base64'
    })
  })

  it.each([
    ['NUL', '\u0000'],
    ['a line feed', 'line\nbreak'],
    ['ESC', '\u001b[0m'],
    ['DEL', '\u007f'],
    ['a C1 control', 'next\u0085line'],
    ['the last C1 control', '\u009f']
  ])('discards decoded text containing %s as control', (_label, text) => {
    expect(parseProgramStatusReport(`state=done:msg=${b64(text)}`)).toMatchObject({
      kind: 'discard',
      reason: 'control'
    })
    expect(parseProgramStatusReport(`state=done:title=${b64(text)}`)).toMatchObject({
      kind: 'discard',
      reason: 'control'
    })
  })

  it('accepts printable non-ASCII decoded text', () => {
    expect(report(`state=done:msg=${b64('Red · Green · Blue \u{1f44b}')}`).report).toMatchObject({
      state: 'done'
    })
  })
})

describe('parseProgramStatusReport: app', () => {
  it('keeps app up to 32 bytes', () => {
    expect(report(`state=idle:app=${'a'.repeat(32)}`).report.app).toBe('a'.repeat(32))
  })

  it('discards app over 32 bytes', () => {
    expect(parseProgramStatusReport(`state=idle:app=${'a'.repeat(33)}`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
  })

  it.each(['a,b', 'a/b', 'a=b', ''])('treats app %j outside its character set as absent', (app) => {
    expect(parseProgramStatusReport(`state=idle:app=${app}`)).toEqual({
      kind: 'report',
      report: { state: 'idle', id: null, kind: null, app: null, progress: null },
      skippedPairs: 0
    })
  })
})

describe('parseProgramStatusReport: id', () => {
  it('accepts nested ids up to 8 levels, 32 bytes per segment, 128 bytes in total', () => {
    const eightLevels = Array.from({ length: 8 }, (_, index) => `s${index}`).join('/')
    expect(report(`state=working:id=${eightLevels}`).report.id).toBe(eightLevels)
    expect(report(`state=working:id=${'x'.repeat(32)}`).report.id).toBe('x'.repeat(32))
    const total128 = ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(29)].join('/')
    expect(total128).toHaveLength(128)
    expect(report(`state=working:id=${total128}`).report.id).toBe(total128)
    expect(report('state=working:id=A-z_0.9+').report.id).toBe('A-z_0.9+')
  })

  it.each([
    ['nine levels', Array.from({ length: 9 }, (_, index) => `s${index}`).join('/')],
    ['a 33-byte segment', 'x'.repeat(33)],
    [
      '129 bytes in total',
      ['a'.repeat(32), 'b'.repeat(32), 'c'.repeat(32), 'd'.repeat(30)].join('/')
    ]
  ])('discards an id with %s as pair-limit', (_label, id) => {
    expect(parseProgramStatusReport(`state=working:id=${id}`)).toMatchObject({
      kind: 'discard',
      reason: 'pair-limit'
    })
  })

  it.each([
    ['empty', ''],
    ['an empty segment', 'a//b'],
    ['a leading slash', '/a'],
    ['a trailing slash', 'a/'],
    ['a comma', 'a,b'],
    ['an equals sign', 'a=b']
  ])('discards an id that is %s as id', (_label, id) => {
    expect(parseProgramStatusReport(`state=working:id=${id}`)).toMatchObject({
      kind: 'discard',
      reason: 'id'
    })
  })
})

describe('parseProgramStatusReport: state, kind and progress', () => {
  it('discards a report with no state', () => {
    expect(parseProgramStatusReport('app=example-cli')).toEqual({
      kind: 'discard',
      reason: 'state',
      skippedPairs: 0
    })
    expect(parseProgramStatusReport('')).toEqual({
      kind: 'discard',
      reason: 'state',
      skippedPairs: 1
    })
  })

  it.each(['paused', 'Working', '', 'done,'])('discards the unrecognized state %j', (state) => {
    expect(parseProgramStatusReport(`state=${state}`)).toMatchObject({
      kind: 'discard',
      reason: 'state'
    })
  })

  it.each(['permission', 'question', 'auth'] as const)('keeps kind %s with blocked', (kind) => {
    expect(report(`state=blocked:kind=${kind}`).report.kind).toBe(kind)
  })

  it('treats kind as absent outside blocked or when unrecognized', () => {
    expect(report('state=working:kind=question').report.kind).toBeNull()
    expect(report('state=blocked:kind=other').report.kind).toBeNull()
    expect(report('state=blocked').report.kind).toBeNull()
  })

  it.each([
    ['0', 0],
    ['100', 100],
    ['42', 42],
    ['0050', 50],
    ['0000000000000100', 100]
  ])('keeps progress %s', (value, progress) => {
    expect(report(`state=working:progress=${value}`).report.progress).toBe(progress)
    expect(report(`state=blocked:progress=${value}`).report.progress).toBe(progress)
  })

  it.each([
    '101',
    '1000',
    '0000000000000101',
    '9'.repeat(400),
    '-1',
    '+5',
    '50.5',
    '1_0',
    'abc',
    ''
  ])('treats progress %j as absent', (value) => {
    expect(report(`state=working:progress=${value}`).report.progress).toBeNull()
  })

  it.each(['done', 'error', 'idle', 'clear'] as const)('ignores progress with %s', (state) => {
    expect(report(`state=${state}:progress=40`).report.progress).toBeNull()
  })

  it('applies limits before semantics, so a bad msg discards a report with no state', () => {
    expect(parseProgramStatusReport('msg=a-b')).toMatchObject({ kind: 'discard', reason: 'base64' })
  })
})
