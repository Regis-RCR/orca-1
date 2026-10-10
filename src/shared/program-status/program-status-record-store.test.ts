import { describe, expect, it } from 'vitest'
import type { ProgramStatusReport } from './program-status-report'
import {
  createProgramStatusRecordStore,
  PROGRAM_STATUS_MAX_RECORDS
} from './program-status-record-store'

function report(
  state: ProgramStatusReport['state'],
  id: string | null = null,
  kind: ProgramStatusReport['kind'] = null
): ProgramStatusReport {
  return { state, id, kind, app: null, progress: null }
}

describe('program status record store: reports', () => {
  it('starts empty with an empty projection', () => {
    const store = createProgramStatusRecordStore()
    expect(store.hasRecords()).toBe(false)
    expect(store.hasActiveRecords()).toBe(false)
    expect(store.recordCount()).toBe(0)
    expect(store.project()).toEqual({ now: null, onExit: null })
  })

  it('replaces a record completely, kind included', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('blocked', null, 'question'))
    expect(store.project().now?.aggregate).toBe('question')
    store.applyReport(report('working'))
    store.applyReport(report('blocked'))
    expect(store.project().now).toEqual({
      aggregate: 'blocked',
      root: 'blocked',
      childError: false
    })
    expect(store.recordCount()).toBe(1)
  })

  it('keeps a record per id', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('done'))
    store.applyReport(report('working', 'a'))
    store.applyReport(report('working', 'a/b'))
    expect(store.recordCount()).toBe(3)
    expect(store.project().now).toEqual({ aggregate: 'working', root: 'done', childError: false })
  })

  it('reports active records while any record is working or blocked', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('done'))
    expect(store.hasRecords()).toBe(true)
    expect(store.hasActiveRecords()).toBe(false)
    store.applyReport(report('blocked', 'a'))
    expect(store.hasActiveRecords()).toBe(true)
    store.applyReport(report('idle', 'a'))
    expect(store.hasActiveRecords()).toBe(false)
    store.applyReport(report('working'))
    expect(store.hasActiveRecords()).toBe(true)
  })
})

describe('program status record store: clear', () => {
  it('removes the addressed record and every record beneath it', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('idle'))
    store.applyReport(report('working', 'a'))
    store.applyReport(report('error', 'a/b'))
    store.applyReport(report('working', 'a/b/c'))
    store.applyReport(report('working', 'ab'))
    store.applyReport(report('clear', 'a'))
    expect(store.recordCount()).toBe(2)
    expect(store.project().now).toEqual({ aggregate: 'working', root: 'idle', childError: false })
    store.applyReport(report('clear', 'ab'))
    expect(store.project().now).toEqual({ aggregate: 'idle', root: 'idle', childError: false })
  })

  it('clears a subtree whose own record is absent', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('working', 'a/b'))
    store.applyReport(report('clear', 'a'))
    expect(store.hasRecords()).toBe(false)
  })

  it('treats a root clear as clearing everything', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('done'))
    store.applyReport(report('working', 'a'))
    store.applyReport(report('clear'))
    expect(store.hasRecords()).toBe(false)
    expect(store.hasActiveRecords()).toBe(false)
    expect(store.project()).toEqual({ now: null, onExit: null })
    store.applyReport(report('clear'))
    expect(store.recordCount()).toBe(0)
  })

  it('follows a child created and cleared like an agent subtask', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('working'))
    store.applyReport(report('working', '0123456789abcdef0'))
    store.applyReport(report('clear', '0123456789abcdef0'))
    store.applyReport(report('done'))
    store.applyReport(report('done'))
    expect(store.project().now).toEqual({ aggregate: 'done', root: 'done', childError: false })
    for (let index = 0; index < 3; index += 1) {
      store.applyReport(report('clear'))
    }
    expect(store.project()).toEqual({ now: null, onExit: null })
  })
})

describe('program status record store: capacity', () => {
  it('holds 256 records', () => {
    expect(PROGRAM_STATUS_MAX_RECORDS).toBe(256)
    const store = createProgramStatusRecordStore()
    for (let index = 0; index < 300; index += 1) {
      store.applyReport(report('idle', `c${index}`))
    }
    expect(store.recordCount()).toBe(256)
  })

  it('evicts the least recently updated record', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('working'))
    for (let index = 0; index < PROGRAM_STATUS_MAX_RECORDS; index += 1) {
      store.applyReport(report('done', `c${index}`))
    }
    expect(store.recordCount()).toBe(256)
    expect(store.project().now).toEqual({ aggregate: 'done', root: null, childError: false })
    expect(store.hasActiveRecords()).toBe(false)
  })

  it('counts an update as recent, so a refreshed record survives', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('working'))
    store.applyReport(report('error', 'oldest'))
    for (let index = 0; index < PROGRAM_STATUS_MAX_RECORDS - 2; index += 1) {
      store.applyReport(report('done', `c${index}`))
    }
    expect(store.project().now).toEqual({ aggregate: 'working', root: 'working', childError: true })
    store.applyReport(report('working'))
    store.applyReport(report('done', 'newest'))
    expect(store.recordCount()).toBe(256)
    expect(store.project().now).toEqual({
      aggregate: 'working',
      root: 'working',
      childError: false
    })
  })
})

describe('program status record store: lifecycle', () => {
  it('drops working and blocked at a prompt start and keeps idle, done and error', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('working'))
    store.applyReport(report('blocked', 'a'))
    store.applyReport(report('idle', 'b'))
    store.applyReport(report('done', 'c'))
    store.applyReport(report('error', 'd'))
    store.applyPromptStart()
    expect(store.recordCount()).toBe(3)
    expect(store.hasActiveRecords()).toBe(false)
    expect(store.project().now).toEqual({ aggregate: 'done', root: null, childError: true })
  })

  it('keeps a root that went idle at the prompt idle', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('working'))
    store.applyReport(report('idle'))
    store.applyPromptStart()
    expect(store.project().now).toEqual({ aggregate: 'idle', root: 'idle', childError: false })
  })

  it('drops everything at a reset', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('done'))
    store.applyReport(report('error', 'a'))
    store.applyReset()
    expect(store.hasRecords()).toBe(false)
    expect(store.project()).toEqual({ now: null, onExit: null })
  })

  it('projects the process exit without mutating: drops working, blocked and idle', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('working'))
    store.applyReport(report('blocked', 'a', 'question'))
    store.applyReport(report('idle', 'b'))
    store.applyReport(report('done', 'c'))
    const before = store.project()
    expect(before).toEqual({
      now: { aggregate: 'question', root: 'working', childError: false },
      onExit: { aggregate: 'done', root: null, childError: false }
    })
    expect(store.projectAfterProcessExit()).toEqual(before.onExit)
    expect(store.recordCount()).toBe(4)
    expect(store.project()).toEqual(before)
  })

  it('keeps a root done or error through the process exit', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('error'))
    store.applyReport(report('working', 'a'))
    expect(store.projectAfterProcessExit()).toEqual({
      aggregate: 'error',
      root: 'error',
      childError: false
    })
    store.applyReport(report('done'))
    expect(store.projectAfterProcessExit()).toEqual({
      aggregate: 'done',
      root: 'done',
      childError: false
    })
  })

  it('projects nothing after exit when only active or idle records remain', () => {
    const store = createProgramStatusRecordStore()
    store.applyReport(report('idle'))
    store.applyReport(report('working', 'a'))
    expect(store.project().onExit).toBeNull()
    expect(store.projectAfterProcessExit()).toBeNull()
  })
})
