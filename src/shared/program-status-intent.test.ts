import { describe, expect, it } from 'vitest'
import {
  isProgramStatusPlatform,
  parseProgramStatusIntent,
  resolveProgramStatusIntent,
  withoutProgramStatusIntent,
  type ProgramStatusOwnerProvider
} from './program-status-intent'
import { parsePtyStartupIngressIntent } from './pty-startup-ingress-intent'

const COLORS = { foreground: '#000000', background: '#ffffff' }

describe('parseProgramStatusIntent', () => {
  it('keeps exactly the ingestion flag', () => {
    expect(parseProgramStatusIntent({ ingest: true })).toEqual({ ingest: true })
    expect(parseProgramStatusIntent({ ingest: true, future: 1 })).toEqual({ ingest: true })
  })

  it('keeps the probe answer only beside ingestion, and only when exactly true', () => {
    expect(parseProgramStatusIntent({ ingest: true, answerProbe: true })).toEqual({
      ingest: true,
      answerProbe: true
    })
    expect(parseProgramStatusIntent({ ingest: true, answerProbe: 'yes' })).toEqual({ ingest: true })
    expect(parseProgramStatusIntent({ answerProbe: true })).toBeUndefined()
  })

  it.each([undefined, null, true, 'ingest', { ingest: 'true' }, { ingest: 1 }, {}, []])(
    'refuses %j',
    (value) => {
      expect(parseProgramStatusIntent(value)).toBeUndefined()
    }
  )
})

describe('resolveProgramStatusIntent: the announced scope', () => {
  const resolve = (platform: string, provider: ProgramStatusOwnerProvider, serveMode = false) =>
    resolveProgramStatusIntent({ platform, provider, serveMode })

  it('ingests and answers the probe on macOS desktop local and daemon PTYs', () => {
    expect(resolve('darwin', 'local')).toEqual({ ingest: true, answerProbe: true })
    expect(resolve('darwin', 'daemon')).toEqual({ ingest: true, answerProbe: true })
  })

  it.each([
    ['linux', 'local'],
    ['linux', 'daemon'],
    ['win32', 'local'],
    ['win32', 'daemon'],
    ['darwin', 'relay'],
    ['linux', 'relay']
  ] as const)('leaves %s %s PTYs unarmed', (platform, provider) => {
    expect(resolve(platform, provider)).toBeUndefined()
  })

  it('leaves headless serve unarmed', () => {
    expect(resolve('darwin', 'local', true)).toBeUndefined()
    expect(resolve('darwin', 'daemon', true)).toBeUndefined()
  })
})

describe('isProgramStatusPlatform: the platform half of the announced scope', () => {
  it.each(['darwin', 'linux', 'win32', 'freebsd'])(
    'agrees with what a local spawn on %s arms',
    (platform) => {
      const armed =
        resolveProgramStatusIntent({ platform, provider: 'local', serveMode: false }) !== undefined
      expect(isProgramStatusPlatform(platform)).toBe(armed)
    }
  )

  it('holds on macOS only', () => {
    expect(isProgramStatusPlatform('darwin')).toBe(true)
    expect(isProgramStatusPlatform('linux')).toBe(false)
    expect(isProgramStatusPlatform('win32')).toBe(false)
  })
})

describe('the startup ingress intent carries program status', () => {
  it('is valid with program status alone, so a plain macOS shell still ingests', () => {
    expect(
      parsePtyStartupIngressIntent({
        colors: {},
        deadlineMs: 5_000,
        programStatus: { ingest: true }
      })
    ).toEqual({ colors: {}, deadlineMs: 5_000, programStatus: { ingest: true } })
  })

  it('keeps it beside colours and Kitty', () => {
    expect(
      parsePtyStartupIngressIntent({
        colors: COLORS,
        kittyKeyboardProtocol: true,
        deadlineMs: 5_000,
        programStatus: { ingest: true }
      })
    ).toEqual({
      colors: COLORS,
      kittyKeyboardProtocol: true,
      deadlineMs: 5_000,
      programStatus: { ingest: true }
    })
  })

  it('drops a malformed request and stays as before without it', () => {
    expect(
      parsePtyStartupIngressIntent({ colors: COLORS, deadlineMs: 5_000, programStatus: 'yes' })
    ).toEqual({ colors: COLORS, deadlineMs: 5_000 })
    expect(
      parsePtyStartupIngressIntent({ colors: {}, deadlineMs: 5_000, programStatus: { ingest: 1 } })
    ).toBeUndefined()
  })

  it('still refuses a bad deadline when program status is present', () => {
    expect(
      parsePtyStartupIngressIntent({ colors: {}, deadlineMs: -1, programStatus: { ingest: true } })
    ).toBeUndefined()
  })

  it('never keeps it for an owner that may not ingest (the relay)', () => {
    const intent = { colors: COLORS, deadlineMs: 5_000, programStatus: { ingest: true } }
    expect(parsePtyStartupIngressIntent(intent, { programStatus: false })).toEqual({
      colors: COLORS,
      deadlineMs: 5_000
    })
    expect(
      parsePtyStartupIngressIntent(
        { colors: {}, deadlineMs: 5_000, programStatus: { ingest: true } },
        { programStatus: false }
      )
    ).toBeUndefined()
  })

  it('strips the request for a daemon below the protocol that relays facts', () => {
    const intent = { colors: COLORS, deadlineMs: 5_000, programStatus: { ingest: true as const } }
    expect(withoutProgramStatusIntent(intent)).toEqual({ colors: COLORS, deadlineMs: 5_000 })
    expect(intent.programStatus).toEqual({ ingest: true })
  })
})
