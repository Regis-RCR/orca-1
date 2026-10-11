import { describe, expect, it } from 'vitest'
import {
  parseProgramStatusAck,
  parseProgramStatusFact,
  PROGRAM_STATUS_INCARNATION_ID_MAX_LENGTH,
  programStatusViewNameForLiveness,
  type ProgramStatusFact,
  type ProgramStatusView
} from './program-status-slot'
import { createProgramStatusTracker } from './program-status-tracker'

const view = (overrides: Partial<ProgramStatusView> = {}): ProgramStatusView => ({
  summary: { aggregate: 'done', root: 'done', childError: false },
  generation: 3,
  changedAt: 1000,
  rootChangedAt: 1000,
  ...overrides
})

const fact = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  incarnationId: 'inc-1',
  reportSeq: 4,
  observation: { now: view(), onExit: view({ generation: 4 }) },
  ...overrides
})

/** Through JSON, as a fact crosses the daemon socket. */
const wire = (value: unknown): unknown => JSON.parse(JSON.stringify(value))

describe('parseProgramStatusFact', () => {
  it('accepts a tracker snapshot sent over the wire, unchanged', () => {
    const tracker = createProgramStatusTracker({ emit: () => undefined })
    tracker.observe('\x1b]7501;state=working\x07\x1b]7501;state=done:id=a\x07', 0, 1234)
    const sent: ProgramStatusFact = { incarnationId: 'inc-1', ...tracker.snapshot() }
    expect(parseProgramStatusFact(wire(sent))).toEqual(sent)
    tracker.dispose()
  })

  it('accepts an empty observation at reportSeq 0, the snapshot of a silent program', () => {
    const empty = fact({ reportSeq: 0, observation: { now: null, onExit: null } })
    expect(parseProgramStatusFact(empty)).toEqual(empty)
  })

  it('accepts a view without a root only with a null rootChangedAt', () => {
    const rootless = view({
      summary: { aggregate: 'done', root: null, childError: true },
      rootChangedAt: null
    })
    expect(parseProgramStatusFact(fact({ observation: { now: rootless, onExit: null } }))).not.toBe(
      null
    )
    const inconsistent = { ...rootless, rootChangedAt: 1000 }
    expect(
      parseProgramStatusFact(fact({ observation: { now: inconsistent, onExit: null } }))
    ).toBeNull()
    const missingTime = view({ rootChangedAt: null })
    expect(
      parseProgramStatusFact(fact({ observation: { now: missingTime, onExit: null } }))
    ).toBeNull()
  })

  it('rebuilds the value from known fields only', () => {
    const parsed = parseProgramStatusFact(
      fact({ extra: 1, observation: { now: { ...view(), extra: 2 }, onExit: null, extra: 3 } })
    )
    expect(parsed).toEqual({
      incarnationId: 'inc-1',
      reportSeq: 4,
      observation: { now: view(), onExit: null }
    })
  })

  it.each([
    ['a non-object', 'nope'],
    ['null', null],
    ['an array', [fact()]],
    ['an empty incarnation id', fact({ incarnationId: '' })],
    [
      'an overlong incarnation id',
      fact({ incarnationId: 'x'.repeat(PROGRAM_STATUS_INCARNATION_ID_MAX_LENGTH + 1) })
    ],
    ['a numeric incarnation id', fact({ incarnationId: 7 })],
    ['a negative reportSeq', fact({ reportSeq: -1 })],
    ['a fractional reportSeq', fact({ reportSeq: 1.5 })],
    ['an unsafe reportSeq', fact({ reportSeq: Number.MAX_SAFE_INTEGER + 1 })],
    ['a missing observation', fact({ observation: undefined })],
    ['a missing view key', fact({ observation: { now: null } })],
    ['a view that is not an object', fact({ observation: { now: 'done', onExit: null } })]
  ])('rejects %s', (_name, value) => {
    expect(parseProgramStatusFact(value)).toBeNull()
  })

  it.each([
    [
      'an unknown aggregate',
      { summary: { aggregate: 'waiting', root: 'done', childError: false } }
    ],
    ['an unknown root', { summary: { aggregate: 'done', root: 'clear', childError: false } }],
    ['a non-boolean childError', { summary: { aggregate: 'done', root: 'done', childError: 0 } }],
    ['a missing summary', { summary: undefined }],
    ['generation 0', { generation: 0 }],
    ['a negative generation', { generation: -2 }],
    ['a fractional generation', { generation: 2.5 }],
    ['a NaN generation', { generation: Number.NaN }],
    ['a string generation', { generation: '3' }],
    ['an infinite changedAt', { changedAt: Number.POSITIVE_INFINITY }],
    ['a NaN changedAt', { changedAt: Number.NaN }],
    ['a string changedAt', { changedAt: '1000' }],
    ['an infinite rootChangedAt', { rootChangedAt: Number.NEGATIVE_INFINITY }]
  ])('rejects a view with %s', (_name, overrides) => {
    const bad = { ...view(), ...overrides }
    expect(parseProgramStatusFact(fact({ observation: { now: bad, onExit: null } }))).toBeNull()
    expect(parseProgramStatusFact(fact({ observation: { now: null, onExit: bad } }))).toBeNull()
  })

  it('rejects NaN and infinities after a JSON round trip too, where they become null', () => {
    const sent = fact({ observation: { now: view({ changedAt: Number.NaN }), onExit: null } })
    expect(parseProgramStatusFact(wire(sent))).toBeNull()
  })
})

describe('parseProgramStatusAck', () => {
  it.each(['now', 'onExit'] as const)('accepts an acknowledgement of the %s view', (name) => {
    const ack = { incarnationId: 'inc-1', view: name, generation: 7 }
    expect(parseProgramStatusAck(wire(ack))).toEqual(ack)
  })

  it.each([
    ['a missing argument', undefined],
    ['an unknown view', { incarnationId: 'inc-1', view: 'later', generation: 7 }],
    ['generation 0', { incarnationId: 'inc-1', view: 'now', generation: 0 }],
    ['a fractional generation', { incarnationId: 'inc-1', view: 'now', generation: 1.5 }],
    [
      'an unsafe generation',
      { incarnationId: 'inc-1', view: 'now', generation: Number.MAX_SAFE_INTEGER + 1 }
    ],
    ['an empty incarnation id', { incarnationId: '', view: 'now', generation: 7 }],
    [
      'an overlong incarnation id',
      {
        incarnationId: 'x'.repeat(PROGRAM_STATUS_INCARNATION_ID_MAX_LENGTH + 1),
        view: 'now',
        generation: 7
      }
    ]
  ])('rejects %s', (_name, value) => {
    expect(parseProgramStatusAck(value)).toBeNull()
  })

  it('returns only the three fields', () => {
    expect(
      parseProgramStatusAck({ incarnationId: 'inc-1', view: 'now', generation: 7, paneKey: 'p' })
    ).toEqual({ incarnationId: 'inc-1', view: 'now', generation: 7 })
  })
})

describe('programStatusViewNameForLiveness', () => {
  it('selects onExit exactly when the process exited', () => {
    expect(programStatusViewNameForLiveness('live')).toBe('now')
    expect(programStatusViewNameForLiveness('unverifiable')).toBe('now')
    expect(programStatusViewNameForLiveness('exited')).toBe('onExit')
  })
})
