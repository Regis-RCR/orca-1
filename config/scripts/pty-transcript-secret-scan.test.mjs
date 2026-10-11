// The scrub gate is the only thing standing between a live agent transcript and a
// committed account identifier, so it is pinned on the shapes those transcripts carry.
import { readdirSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  formatFindings,
  placeholderFor,
  redactTranscript,
  scanTranscriptForSecrets
} from './pty-transcript-secret-scan.mjs'
import { parseArgs, resolveSpawn } from './capture-agent-pty-transcript.mjs'

describe('pty transcript secret scan', () => {
  it('finds the account row of a ready screen', () => {
    const findings = scanTranscriptForSecrets('Antigravity CLI 1.1.17\njin.woo@acme.dev (Business)')
    expect(findings).toHaveLength(1)
    expect(findings[0]).toMatchObject({ kind: 'email', line: 2, column: 1 })
  })

  it('finds credentials an agent may echo while signing in', () => {
    const kinds = scanTranscriptForSecrets(
      [
        'token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP',
        'key: AIzaSyA1234567890abcdefghijklmnopqrstu',
        'refresh: 1//0gLm34XyZabcdefghijklmnopqrstuvwx',
        'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345'
      ].join('\n')
    ).map((finding) => finding.kind)
    expect(kinds).toEqual(['jwt', 'google-api-key', 'google-refresh-token', 'bearer-token'])
  })

  it('flags this machine’s own username, which a prompt line leaks', () => {
    const username = os.userInfo().username
    const findings = scanTranscriptForSecrets(`~/Users/${username}/orca/repo\n> `)
    expect(findings.some((finding) => finding.kind === 'local-username')).toBe(true)
  })

  it('finds the resumable conversation id agy prints on exit', () => {
    const findings = scanTranscriptForSecrets(
      'Resume with -c (or command below):\nagy --conversation=26dc1986-9eec-456a-a534-d93e5c1076c2'
    )
    expect(findings).toHaveLength(1)
    expect(findings[0].kind).toBe('uuid')
    expect(placeholderFor('uuid', findings[0].match.length)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )
  })

  it('reports a clean transcript as clean', () => {
    const findings = scanTranscriptForSecrets('Antigravity CLI 1.1.17\nSonnet 4.6 (High)\n> ')
    expect(findings).toEqual([])
    expect(formatFindings('fixture', findings)).toContain('clean')
  })

  it('claims a span once, so a token inside an email is not double-reported', () => {
    const findings = scanTranscriptForSecrets('longlivedaccountname@corp.internal')
    expect(findings).toHaveLength(1)
  })

  it('passes a fixture that is already scrubbed, so "prove it is gone" can succeed', () => {
    const scrubbed = `uuuu@example.com\n${'X'.repeat(44)}`
    expect(scanTranscriptForSecrets(scrubbed)).toEqual([])
  })
})

describe('OSC 7501 report text fields', () => {
  const ESC = String.fromCharCode(0x1b)
  const BEL = String.fromCharCode(0x07)
  const report = (body) => `${ESC}]7501;${body}${BEL}`
  const encode = (text) => Buffer.from(text, 'utf8').toString('base64')
  const LONG_RUN = /[A-Za-z0-9_-]{40,}/

  it('passes msg and title values whose decoded text is clean, however long the encoding', () => {
    const msg = encode('answer: Which colour do you prefer for the agent panel today?')
    const title = encode('agent task title that is long enough to encode past forty')
    expect(msg).toMatch(LONG_RUN)
    expect(title).toMatch(LONG_RUN)
    const text = `> ${report(`state=blocked:kind=question:msg=${msg}:title=${title}`)}\n`
    expect(scanTranscriptForSecrets(text)).toEqual([])
  })

  it.each([
    ['msg', 'an email', 'reach me at jin.woo@acme.dev about the agent run', 'encoded-email'],
    [
      'title',
      'a bearer token',
      'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
      'encoded-bearer-token'
    ],
    [
      'msg',
      'a vendor key',
      'use sk-abcdefghijklmnopqrstuvwxyz0123 for the agent',
      'encoded-vendor-key'
    ]
  ])(
    'flags a %s whose decoded text carries %s, at the encoded span',
    (key, _what, decoded, kind) => {
      const value = encode(decoded)
      const text = `line one\n${report(`state=done:${key}=${value}`)}`
      const findings = scanTranscriptForSecrets(text)
      expect(findings).toEqual([
        { kind, index: text.indexOf(value), match: value, line: 2, column: text.indexOf(value) - 8 }
      ])
      const { text: redacted } = redactTranscript(text)
      expect(redacted).toHaveLength(text.length)
      expect(scanTranscriptForSecrets(redacted)).toEqual([])
    }
  )

  it('still flags a long opaque token outside any 7501 text field', () => {
    const token = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0u1'
    const text = `${report(`state=done:msg=${encode('all clear for the agent here')}`)} ${token}`
    expect(scanTranscriptForSecrets(text)).toMatchObject([
      { kind: 'opaque-token', match: token, index: text.indexOf(token) }
    ])
  })

  it.each([
    ['a non-canonical length', `${'Zm9vYmFy'.repeat(5)}Z`],
    [
      'bytes that are not UTF-8',
      Buffer.from(Array.from({ length: 45 }, (_, i) => 0x80 + (i % 60))).toString('base64')
    ]
  ])('falls back to the opaque-token rule for a msg with %s', (_name, value) => {
    expect(value).toMatch(LONG_RUN)
    const text = report(`state=done:msg=${value}`)
    expect(scanTranscriptForSecrets(text).map((finding) => finding.kind)).toEqual(['opaque-token'])
  })
})

describe('redaction', () => {
  it('replaces every finding with the same number of characters', () => {
    // Why length matters: the fixture's value is its exact wrapping. A shorter
    // replacement reflows the screen and invalidates the capture.
    const text = 'Antigravity CLI 1.1.17\njin.woo@acme.dev (Antigravity Business)\n> '
    const { text: redacted, redacted: count } = redactTranscript(text)
    expect(count).toBe(1)
    expect(redacted).toHaveLength(text.length)
    expect(redacted).not.toContain('jin.woo@acme.dev')
    expect(scanTranscriptForSecrets(redacted)).toEqual([])
    expect(redactTranscript(redacted).redacted).toBe(0)
  })

  it('keeps a redacted email shaped like an email', () => {
    expect(placeholderFor('email', 'a@b.example.com'.length)).toMatch(/^u+@example\.com$/)
  })

  it('leaves the rest of the screen byte-for-byte untouched', () => {
    const text = 'line one\nuser@corp.io\nline three'
    expect(redactTranscript(text).text.split('\n')[2]).toBe('line three')
  })
})

describe('committed transcripts', () => {
  // Why in CI and not just in the recorder: a transcript is committed once and read forever.
  // The capture-time warning is skippable; this is not.
  const fixtureDir = join(import.meta.dirname, '..', '..', 'src', 'main', 'runtime', '__fixtures__')
  const transcripts = readdirSync(fixtureDir).filter((entry) => entry.endsWith('.txt'))

  it.each(transcripts)('%s carries no account identifier or credential', (name) => {
    const findings = scanTranscriptForSecrets(readFileSync(join(fixtureDir, name), 'utf8'))
    expect(formatFindings(name, findings)).toContain('clean')
  })
})

describe('capture argv', () => {
  it('splits recorder options from the agent command', () => {
    const { options, command } = parseArgs([
      '--name',
      'antigravity-ready-personal-non-gemini',
      '--cols',
      '120',
      '--',
      'agy',
      '--model',
      'sonnet'
    ])
    expect(options.name).toBe('antigravity-ready-personal-non-gemini')
    expect(options.cols).toBe(120)
    expect(command).toEqual(['agy', '--model', 'sonnet'])
  })

  it('collects a multi-file scan list', () => {
    const { options } = parseArgs(['--scan', 'a.txt', 'b.txt', '--redact'])
    expect(options.scan).toEqual(['a.txt', 'b.txt'])
    expect(options.redact).toBe(true)
  })

  it('routes a Windows shim through cmd.exe, which node-pty cannot spawn directly', () => {
    expect(resolveSpawn(['agy.cmd', '--model', 'sonnet'])).toEqual(
      process.platform === 'win32'
        ? { file: 'cmd.exe', args: ['/c', '"agy.cmd"', '--model', 'sonnet'] }
        : { file: 'agy.cmd', args: ['--model', 'sonnet'] }
    )
  })
})
