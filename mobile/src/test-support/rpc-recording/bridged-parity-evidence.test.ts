import { describe, expect, it } from 'vitest'
import { readBridgeHostMessage } from '../../mobile-web-shell/bridge/bridge-envelope'
import { firstDifference } from './golden-recording'
import { canonicalJson, OBSERVATION_FIELDS } from './golden-value-pool'
import type { Observation, Recording, RecordingScenario } from './recording-scenario'
import type { RecordedValue } from './recording-values'

/**
 * The four facts a divergence is named from, each read off the run rather than off its message.
 *
 * Named in a `.test.ts` for the reason `bridged-parity-classes.test.ts` gives: neither the recorder
 * digest nor the recorder's fence reaches this name, and reading a failure cannot change a golden.
 */

/** Frames the shell posted that the page's own reader drops. Read back through that same reader. */
export function refusedFrames(posted: readonly string[]): string[] {
  return posted.filter((json) => !readBridgeHostMessage(json).ok)
}

/**
 * The same frame with a `_meta` on its reply payload, which is the one field the page's reader
 * demands and the wire the page stands in for does not. Anything that is not a reply comes back
 * untouched, so this can sit on a whole lane.
 */
export function withReplyMeta(json: string): string {
  const frame: unknown = JSON.parse(json)
  if (typeof frame !== 'object' || frame === null || !('payload' in frame)) {
    return json
  }
  const payload = frame.payload
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return json
  }
  return JSON.stringify({
    ...frame,
    payload: { ...payload, _meta: { runtimeId: 'counterfactual-runtime' } }
  })
}

/**
 * Every `_meta` the counterfactual added, gone again.
 *
 * A reply the page accepted resolves to the caller whole, `_meta` included, so a run that was given
 * the field records it where the faithful run records nothing. Removing it is what makes the two
 * runs comparable; it is a key the recorder never sees on this corpus, so nothing else is lost.
 */
export function withoutRpcMeta(value: RecordedValue): RecordedValue {
  if (Array.isArray(value)) {
    return value.map(withoutRpcMeta)
  }
  if (typeof value !== 'object' || value === null) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== '_meta')
      .map(([key, entry]) => [key, withoutRpcMeta(entry)])
  )
}

/** A recording with the counterfactual's fingerprints removed, ready to diff against a golden. */
export function recordingWithoutRpcMeta(recording: Recording): Recording {
  return {
    scenario: recording.scenario,
    checkpoints: recording.checkpoints.map((checkpoint) => ({
      id: checkpoint.id,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: `withoutRpcMeta` preserves shape, so an observation maps to an observation.
      observation: withoutRpcMeta(checkpoint.observation) as Observation
    }))
  }
}

/**
 * Every field path that differs, in the vocabulary `compareGolden` prints, and `checkpoints` when
 * the two runs did not even reach the same checkpoints. All of them, not the first: a rule that
 * needs to know whether *every* field that moved is an ordinal cannot be given only one.
 */
export function divergingFields(expected: Recording, actual: Recording): string[] {
  const expectedIds = expected.checkpoints.map((checkpoint) => checkpoint.id)
  const actualIds = actual.checkpoints.map((checkpoint) => checkpoint.id)
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    return ['checkpoints']
  }
  const fields: string[] = []
  for (const [index, checkpoint] of expected.checkpoints.entries()) {
    const found = actual.checkpoints[index]
    if (found === undefined) {
      return ['checkpoints']
    }
    for (const field of OBSERVATION_FIELDS) {
      const mine = checkpoint.observation[field]
      const theirs = found.observation[field]
      if (canonicalJson(mine) === canonicalJson(theirs)) {
        continue
      }
      fields.push(`${field}${firstDifference(mine, theirs).path}`)
    }
  }
  return fields
}

/** A reply shape the wire itself drops: `ok` with no `result` key at all. */
export function scriptsAbsentResultReply(scenario: RecordingScenario): boolean {
  return scenario.steps.some((step) => {
    if (!('reply' in step) || typeof step.reply !== 'object' || step.reply === null) {
      return false
    }
    return 'ok' in step.reply && step.reply.ok === true && !('result' in step.reply)
  })
}

function undefinedValuedKey(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(undefinedValuedKey)
  }
  if (typeof value !== 'object' || value === null) {
    return false
  }
  return Object.values(value).some((entry) => entry === undefined || undefinedValuedKey(entry))
}

/** The key JSON drops on the way across, so the shell projects params that never had it. */
export function sendsUndefinedValuedParam(scenario: RecordingScenario): boolean {
  return scenario.steps.some((step) => 'params' in step && undefinedValuedKey(step.params))
}

const scenario = (steps: RecordingScenario['steps']): RecordingScenario => ({
  id: 's',
  operation: 'o',
  version: 1,
  family: 'f',
  sites: [],
  schedules: [],
  steps
})

const recording = (
  observation: Partial<Recording['checkpoints'][number]['observation']>
): Recording => ({
  scenario: 's',
  checkpoints: [
    {
      id: 'only',
      observation: {
        sender: [],
        payloads: [],
        settlements: {},
        state: null,
        effects: [],
        ...observation
      }
    }
  ]
})

describe('reading the refused frames back', () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaa'

  it('keeps only what the page would drop', () => {
    const dropped = JSON.stringify({ v: 1, type: 'reply', id, payload: { id: 'f', ok: true } })
    const kept = JSON.stringify({ v: 1, type: 'end', id, reason: 'closed' })
    expect(refusedFrames([dropped, kept])).toEqual([dropped])
  })

  it('takes a reply the page refused only for the missing field', () => {
    const refused = JSON.stringify({
      v: 1,
      type: 'reply',
      id,
      payload: { id: 'f', ok: true, result: 1 }
    })
    expect(readBridgeHostMessage(refused).ok).toBe(false)
    expect(readBridgeHostMessage(withReplyMeta(refused)).ok).toBe(true)
  })

  it('leaves a payload the page refuses for its own shape refused', () => {
    const absent = JSON.stringify({ v: 1, type: 'reply', id, payload: { id: 'f', ok: true } })
    expect(readBridgeHostMessage(withReplyMeta(absent)).ok).toBe(false)
  })

  it('leaves anything that is not a reply alone', () => {
    const end = JSON.stringify({ v: 1, type: 'end', id, reason: 'closed' })
    expect(withReplyMeta(end)).toBe(end)
  })
})

describe('undoing the counterfactual', () => {
  it('removes every `_meta`, however deep, and nothing else', () => {
    expect(
      withoutRpcMeta([{ value: { ok: true, _meta: { runtimeId: 'r' }, result: [1] } }])
    ).toEqual([{ value: { ok: true, result: [1] } }])
  })
})

describe('the fields that diverged', () => {
  it('reports every one, not the first', () => {
    const expected = recording({ sender: [{ ordinal: 1 }], effects: [{ name: 'a' }] })
    const actual = recording({ sender: [{ ordinal: 2 }], effects: [{ name: 'b' }] })
    expect(divergingFields(expected, actual)).toEqual(['sender[0].ordinal', 'effects[0].name'])
  })

  it('names the checkpoint list when the two runs did not reach the same ones', () => {
    const expected = recording({})
    const actual: Recording = { scenario: 's', checkpoints: [] }
    expect(divergingFields(expected, actual)).toEqual(['checkpoints'])
  })

  it('is empty when the two agree', () => {
    expect(divergingFields(recording({}), recording({}))).toEqual([])
  })
})

describe('reading the scenario', () => {
  it('sees a reply that is `ok` with no `result` key', () => {
    expect(
      scriptsAbsentResultReply(scenario([{ complete: 'a#1', params: null, reply: { ok: true } }]))
    ).toBe(true)
    expect(
      scriptsAbsentResultReply(
        scenario([{ complete: 'a#1', params: null, reply: { ok: true, result: null } }])
      )
    ).toBe(false)
  })

  it('sees an own param key whose value is `undefined`, however deep', () => {
    expect(
      sendsUndefinedValuedParam(scenario([{ complete: 'a#1', params: { q: undefined } }]))
    ).toBe(true)
    expect(
      sendsUndefinedValuedParam(scenario([{ complete: 'a#1', params: { q: [{ r: undefined }] } }]))
    ).toBe(true)
    expect(sendsUndefinedValuedParam(scenario([{ complete: 'a#1', params: { q: null } }]))).toBe(
      false
    )
  })
})
