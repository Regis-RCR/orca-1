import { describe, expect, it } from 'vitest'
import {
  summarizeProgramStatusRecords,
  type ProgramStatusRecord,
  type ProgramStatusRecordState
} from './program-status-projection'

function root(state: ProgramStatusRecordState, kind: ProgramStatusRecord['kind'] = null) {
  return { id: null, state, kind }
}

function child(
  id: string,
  state: ProgramStatusRecordState,
  kind: ProgramStatusRecord['kind'] = null
) {
  return { id, state, kind }
}

describe('summarizeProgramStatusRecords', () => {
  it('returns null for no records', () => {
    expect(summarizeProgramStatusRecords([])).toBeNull()
  })

  it.each([
    ['working', 'working'],
    ['done', 'done'],
    ['error', 'error'],
    ['idle', 'idle'],
    ['blocked', 'blocked']
  ] as const)('keeps a lone root %s as %s', (state, summary) => {
    expect(summarizeProgramStatusRecords([root(state)])).toEqual({
      aggregate: summary,
      root: summary,
      childError: false
    })
  })

  it('projects a blocked root with kind question as question', () => {
    expect(summarizeProgramStatusRecords([root('blocked', 'question')])).toEqual({
      aggregate: 'question',
      root: 'question',
      childError: false
    })
  })

  it.each(['permission', 'auth'] as const)(
    'keeps a blocked root with kind %s as blocked',
    (kind) => {
      expect(summarizeProgramStatusRecords([root('blocked', kind)])?.aggregate).toBe('blocked')
    }
  )

  it('takes the root from the root record whatever the aggregate', () => {
    expect(summarizeProgramStatusRecords([root('done'), child('a', 'working')])).toEqual({
      aggregate: 'working',
      root: 'done',
      childError: false
    })
    expect(summarizeProgramStatusRecords([root('error'), child('a', 'blocked')])).toEqual({
      aggregate: 'blocked',
      root: 'error',
      childError: false
    })
  })

  it('reports no root when only children exist', () => {
    expect(summarizeProgramStatusRecords([child('a', 'working')])).toEqual({
      aggregate: 'working',
      root: null,
      childError: false
    })
  })

  it('never lets a child error become the aggregate error', () => {
    expect(summarizeProgramStatusRecords([child('a', 'error')])).toEqual({
      aggregate: 'done',
      root: null,
      childError: true
    })
    expect(summarizeProgramStatusRecords([root('idle'), child('a', 'error')])).toEqual({
      aggregate: 'done',
      root: 'idle',
      childError: true
    })
    expect(summarizeProgramStatusRecords([root('done'), child('a', 'error')])).toEqual({
      aggregate: 'done',
      root: 'done',
      childError: true
    })
  })

  it('lets only the root fail the main agent', () => {
    expect(summarizeProgramStatusRecords([root('error'), child('a', 'done')])).toEqual({
      aggregate: 'error',
      root: 'error',
      childError: false
    })
  })

  it('projects a done child above an idle root', () => {
    expect(summarizeProgramStatusRecords([root('idle'), child('a', 'done')])?.aggregate).toBe(
      'done'
    )
  })

  it('does not count an idle child', () => {
    expect(summarizeProgramStatusRecords([root('done'), child('a', 'idle')])).toEqual({
      aggregate: 'done',
      root: 'done',
      childError: false
    })
  })

  it('orders blocked and question above working above error above done above idle', () => {
    expect(summarizeProgramStatusRecords([root('error'), child('a', 'working')])?.aggregate).toBe(
      'working'
    )
    expect(
      summarizeProgramStatusRecords([root('working'), child('a', 'blocked', 'permission')])
        ?.aggregate
    ).toBe('blocked')
    expect(
      summarizeProgramStatusRecords([child('a', 'blocked', 'question'), root('working')])?.aggregate
    ).toBe('question')
    expect(summarizeProgramStatusRecords([root('error'), child('a', 'done')])?.aggregate).toBe(
      'error'
    )
    expect(summarizeProgramStatusRecords([root('idle'), child('a', 'error')])?.aggregate).toBe(
      'done'
    )
  })

  it('breaks a blocked and question tie by the most recent update', () => {
    expect(
      summarizeProgramStatusRecords([child('a', 'blocked', 'question'), child('b', 'blocked')])
        ?.aggregate
    ).toBe('blocked')
    expect(
      summarizeProgramStatusRecords([child('b', 'blocked'), child('a', 'blocked', 'question')])
        ?.aggregate
    ).toBe('question')
    expect(
      summarizeProgramStatusRecords([root('blocked', 'question'), child('a', 'blocked')])
    ).toEqual({ aggregate: 'blocked', root: 'question', childError: false })
  })

  it('keeps idle, done and error distinct', () => {
    const states = (['idle', 'done', 'error'] as const).map(
      (state) => summarizeProgramStatusRecords([root(state)])?.aggregate
    )
    expect(new Set(states).size).toBe(3)
  })

  it('projects idle children with no root as idle (see the module)', () => {
    expect(summarizeProgramStatusRecords([child('a', 'idle')])).toEqual({
      aggregate: 'idle',
      root: null,
      childError: false
    })
  })
})
