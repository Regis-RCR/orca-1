import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { ProgramStatusPaneIpcPayload } from '../../shared/program-status/program-status-pane-payload'
import type {
  ProgramStatusAck,
  ProgramStatusIdentity,
  ProgramStatusLifecycleWrite,
  ProgramStatusLiveness,
  ProgramStatusReportWrite,
  ProgramStatusSummaryState,
  ProgramStatusView
} from '../../shared/program-status/program-status-slot'
import { CLOSED_AGENT_STATUS_PANE_KEYS_MAX } from './server/server-constants'
import { AgentHookServer } from './server'
import { LEAF_1, LEAF_2, LEAF_3 } from './server.test-fixtures'

const PANE = makePaneKey('tab-1', LEAF_1)
const OTHER_PANE = makePaneKey('tab-2', LEAF_2)
const THIRD_PANE = makePaneKey('tab-3', LEAF_3)
const PTY: ProgramStatusIdentity = { ptyId: 'pty-1', incarnationId: 'inc-1' }
const NEXT_INCARNATION: ProgramStatusIdentity = { ptyId: 'pty-1', incarnationId: 'inc-2' }
const OTHER_PTY: ProgramStatusIdentity = { ptyId: 'pty-2', incarnationId: 'inc-9' }

function view(
  aggregate: ProgramStatusSummaryState,
  generation: number,
  changedAt = 1_000
): ProgramStatusView {
  return {
    summary: { aggregate, root: aggregate, childError: false },
    generation,
    changedAt,
    rootChangedAt: changedAt
  }
}

function report(
  reportSeq: number,
  shown: ProgramStatusView | null,
  liveness: ProgramStatusLiveness = 'live',
  identity: ProgramStatusIdentity = PTY,
  livenessChangedAt = 100
): ProgramStatusReportWrite {
  return { kind: 'report', identity, reportSeq, shown, liveness, livenessChangedAt }
}

function lifecycle(
  liveness: ProgramStatusLiveness,
  extra: Partial<ProgramStatusLifecycleWrite> = {},
  livenessChangedAt = 200
): ProgramStatusLifecycleWrite {
  return { kind: 'lifecycle', identity: PTY, liveness, livenessChangedAt, ...extra }
}

function ackOf(shown: ProgramStatusView, viewName: 'now' | 'onExit' = 'now'): ProgramStatusAck {
  return { incarnationId: PTY.incarnationId, view: viewName, generation: shown.generation }
}

function harness() {
  const server = new AgentHookServer()
  const rows: ProgramStatusPaneIpcPayload[] = []
  server.setProgramStatusListener((row) => rows.push(row))
  const slotAt = (paneKey: string) =>
    server.getProgramStatusSnapshot().find((row) => row.paneKey === paneKey)?.programStatus
  const ingest = (write: ProgramStatusReportWrite, paneKey: string = PANE, worktreeId = 'wt-1') =>
    server.ingestProgramStatusReport({
      paneKey,
      tabId: paneKey.split(':')[0],
      worktreeId,
      write
    })
  return { server, rows, slotAt, ingest }
}

describe('program-status slot: reports', () => {
  it('stores and publishes a report on an empty pane as a slot row', () => {
    const { rows, slotAt, ingest } = harness()
    expect(ingest(report(1, view('working', 1)))).toBe(true)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      programStatusOnly: true,
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      programStatus: { ptyId: 'pty-1', reportSeq: 1, liveness: 'live', view: 'now' }
    })
    expect(Object.keys(rows[0]).sort()).toEqual(
      ['paneKey', 'programStatus', 'programStatusOnly', 'revision', 'tabId', 'worktreeId'].sort()
    )
    expect(slotAt(PANE)?.shown.summary.aggregate).toBe('working')
  })

  it('refuses a stale or equal reportSeq and publishes nothing', () => {
    const { rows, ingest, slotAt } = harness()
    ingest(report(3, view('working', 1)))
    expect(ingest(report(3, view('done', 2)))).toBe(false)
    expect(ingest(report(2, view('done', 2)))).toBe(false)
    expect(rows).toHaveLength(1)
    expect(slotAt(PANE)?.reportSeq).toBe(3)
  })

  it('accepts a new incarnation as a replacement whatever its reportSeq', () => {
    const { ingest, slotAt } = harness()
    ingest(report(9, view('working', 4)))
    expect(ingest(report(1, view('done', 1), 'live', NEXT_INCARNATION))).toBe(true)
    expect(slotAt(PANE)).toMatchObject({ incarnationId: 'inc-2', reportSeq: 1 })
  })

  it('a null report removes the slot with a tombstone of a higher revision', () => {
    const { rows, ingest, slotAt } = harness()
    ingest(report(1, view('working', 1)))
    expect(ingest(report(2, null))).toBe(true)
    expect(rows).toHaveLength(2)
    expect(rows[1].programStatus).toBeNull()
    expect(rows[1].revision).toBeGreaterThan(rows[0].revision)
    expect(slotAt(PANE)).toBeUndefined()
  })

  it('a null report on an empty pane is a no-op', () => {
    const { rows, ingest } = harness()
    expect(ingest(report(1, null))).toBe(false)
    expect(rows).toEqual([])
  })

  it('resolves the pane alias before writing', () => {
    const { server, ingest, slotAt } = harness()
    server.transferPaneAuthority(PANE, OTHER_PANE)
    ingest(report(1, view('working', 1)), PANE)
    expect(slotAt(OTHER_PANE)?.reportSeq).toBe(1)
    expect(slotAt(PANE)).toBeUndefined()
  })

  it('revisions are monotonic across panes and removals', () => {
    const { rows, ingest } = harness()
    ingest(report(1, view('working', 1)), PANE)
    ingest(report(1, view('working', 1), 'live', OTHER_PTY), OTHER_PANE)
    ingest(report(2, null), PANE)
    ingest(report(3, view('done', 2)), PANE)
    const revisions = rows.map((row) => row.revision)
    expect(revisions).toEqual([...revisions].sort((a, b) => a - b))
    expect(new Set(revisions).size).toBe(revisions.length)
  })
})

describe('program-status slot: lifecycle writes', () => {
  it('moves liveness without a reportSeq and keeps the view', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(4, view('working', 2)))
    expect(server.applyProgramStatusLifecycle(PANE, lifecycle('unverifiable'))).toBe(true)
    expect(slotAt(PANE)).toMatchObject({
      reportSeq: 4,
      liveness: 'unverifiable',
      livenessChangedAt: 200,
      shown: { generation: 2 }
    })
    expect(server.applyProgramStatusLifecycle(PANE, lifecycle('live'))).toBe(true)
    expect(slotAt(PANE)?.liveness).toBe('live')
  })

  it('refuses a lifecycle write of another identity or on an empty pane', () => {
    const { server, ingest } = harness()
    expect(server.applyProgramStatusLifecycle(PANE, lifecycle('unverifiable'))).toBe(false)
    ingest(report(1, view('working', 1), 'live', OTHER_PTY))
    expect(server.applyProgramStatusLifecycle(PANE, lifecycle('unverifiable'))).toBe(false)
  })

  it('the exit shows onExit, is absorbing, and a later exited report still lands', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('working', 1)))
    const onExit = view('done', 2)
    server.applyProgramStatusLifecycle(
      PANE,
      lifecycle('exited', { shown: onExit, prevNow: view('working', 1) })
    )
    expect(slotAt(PANE)).toMatchObject({ liveness: 'exited', view: 'onExit' })
    expect(server.applyProgramStatusLifecycle(PANE, lifecycle('live'))).toBe(false)
    expect(ingest(report(2, view('working', 3), 'live'))).toBe(false)
    expect(ingest(report(2, view('error', 3), 'exited'))).toBe(true)
    expect(slotAt(PANE)?.shown.summary.aggregate).toBe('error')
  })

  it('an exit with no onExit view removes the slot', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('working', 1)))
    server.applyProgramStatusLifecycle(
      PANE,
      lifecycle('exited', { shown: null, prevNow: view('working', 1) })
    )
    expect(slotAt(PANE)).toBeUndefined()
  })
})

describe('program-status slot: closure', () => {
  it('a closed pane forgets its record with a tombstone and refuses writes until reopened', () => {
    const { server, rows, ingest, slotAt } = harness()
    ingest(report(1, view('working', 1)))
    server.closeProgramStatusPane(PANE)
    expect(rows.at(-1)).toMatchObject({ paneKey: PANE, programStatus: null })
    expect(ingest(report(2, view('done', 2)))).toBe(false)
    expect(server.applyProgramStatusLifecycle(PANE, lifecycle('unverifiable'))).toBe(false)
    expect(slotAt(PANE)).toBeUndefined()
    server.reopenProgramStatusPane(PANE)
    expect(ingest(report(2, view('done', 2)))).toBe(true)
    expect(slotAt(PANE)?.reportSeq).toBe(2)
  })

  it('closing a pane with no record publishes nothing', () => {
    const { server, rows } = harness()
    server.closeProgramStatusPane(PANE)
    expect(rows).toEqual([])
  })

  it('a closed tab forgets its records and refuses writes, and a reopen does not lift it', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('working', 1)))
    ingest(report(1, view('working', 1), 'live', OTHER_PTY), OTHER_PANE)
    server.dropStatusEntriesByTabPrefix('tab-1')
    server.closeProgramStatusTab('tab-1')
    expect(slotAt(PANE)).toBeUndefined()
    expect(slotAt(OTHER_PANE)).toBeDefined()
    server.reopenProgramStatusPane(PANE)
    expect(ingest(report(2, view('done', 2)))).toBe(false)
  })

  it('a removed worktree forgets and closes its local records only', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('working', 1)), PANE, 'repo::/wt/removed')
    ingest(report(1, view('working', 1), 'live', OTHER_PTY), OTHER_PANE, 'repo::/wt/kept')
    server.forgetProgramStatusForRemovedWorktree('repo::/wt/removed', 'runtime:env-1')
    server.forgetProgramStatusForRemovedWorktree('repo::/wt/removed', 'ssh:box')
    expect(slotAt(PANE)).toBeDefined()
    server.forgetProgramStatusForRemovedWorktree('repo::/wt/removed', 'local')
    expect(slotAt(PANE)).toBeUndefined()
    expect(slotAt(OTHER_PANE)).toBeDefined()
    expect(ingest(report(2, view('done', 2)), PANE, 'repo::/wt/removed')).toBe(false)
  })

  it('the closed set is bounded, oldest evicted', () => {
    const { server, ingest } = harness()
    server.closeProgramStatusPane(PANE)
    for (let index = 0; index < CLOSED_AGENT_STATUS_PANE_KEYS_MAX; index += 1) {
      server.closeProgramStatusPane(`tab-x:${index}`)
    }
    expect(ingest(report(1, view('working', 1)))).toBe(true)
  })
})

describe('program-status slot: rekey and forget', () => {
  it('rekey moves the record to the target pane with a tombstone at the source', () => {
    const { server, rows, ingest, slotAt } = harness()
    ingest(report(2, view('working', 1)))
    const moved = server.rekeyProgramStatus(
      PANE,
      { paneKey: OTHER_PANE, tabId: 'tab-2' },
      PTY,
      report(2, view('working', 1))
    )
    expect(moved).toBe(true)
    expect(slotAt(PANE)).toBeUndefined()
    expect(slotAt(OTHER_PANE)?.reportSeq).toBe(2)
    expect(rows.at(-2)).toMatchObject({ paneKey: PANE, programStatus: null })
    expect(rows.at(-1)).toMatchObject({ paneKey: OTHER_PANE, tabId: 'tab-2', worktreeId: 'wt-1' })
  })

  it('rekey falls back to the current report when the source no longer holds the record', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(2, view('working', 1)))
    server.closeProgramStatusPane(PANE)
    server.rekeyProgramStatus(
      PANE,
      { paneKey: OTHER_PANE, tabId: 'tab-2', worktreeId: 'wt-1' },
      PTY,
      report(2, view('working', 1))
    )
    expect(slotAt(OTHER_PANE)).toMatchObject({ reportSeq: 2, ptyId: 'pty-1' })
  })

  it('rekey leaves another identity at the source untouched', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('working', 1), 'live', OTHER_PTY))
    server.rekeyProgramStatus(PANE, { paneKey: OTHER_PANE }, PTY, report(1, view('done', 1)))
    expect(slotAt(PANE)?.ptyId).toBe('pty-2')
    expect(slotAt(OTHER_PANE)?.ptyId).toBe('pty-1')
  })

  it('a forget from a replaced PTY cannot remove its successor', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('working', 1), 'live', NEXT_INCARNATION))
    expect(server.forgetProgramStatus(PANE, PTY)).toBe(false)
    expect(slotAt(PANE)?.incarnationId).toBe('inc-2')
    expect(server.forgetProgramStatus(PANE, NEXT_INCARNATION)).toBe(true)
    expect(slotAt(PANE)).toBeUndefined()
  })
})

describe('program-status slot: dismissal by ptyId', () => {
  it('an exact ack hides the slot as a null row; a stale ack changes nothing', () => {
    const { server, rows, ingest, slotAt } = harness()
    const done = view('done', 3)
    ingest(report(1, done))
    const before = rows.length
    expect(server.acknowledgeProgramStatus(PANE, ackOf(view('done', 2)))).toBe(false)
    expect(server.acknowledgeProgramStatus(PANE, { ...ackOf(done), view: 'onExit' })).toBe(false)
    expect(server.acknowledgeProgramStatus(PANE, { ...ackOf(done), incarnationId: 'x' })).toBe(
      false
    )
    expect(rows).toHaveLength(before)
    expect(server.acknowledgeProgramStatus(PANE, ackOf(done))).toBe(true)
    expect(rows.at(-1)).toMatchObject({ paneKey: PANE, programStatus: null })
    expect(slotAt(PANE)).toBeNull()
    expect(server.acknowledgeProgramStatus(PANE, ackOf(done))).toBe(false)
  })

  it('a coalesced transition carries a new generation and shows again', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('done', 3)))
    server.acknowledgeProgramStatus(PANE, ackOf(view('done', 3)))
    ingest(report(2, view('done', 5)))
    expect(slotAt(PANE)?.shown.generation).toBe(5)
  })

  it('an equal snapshot, a link loss and a reconnect keep it hidden', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('done', 3)))
    server.acknowledgeProgramStatus(PANE, ackOf(view('done', 3)))
    ingest(report(1, view('done', 3)))
    server.applyProgramStatusLifecycle(PANE, lifecycle('unverifiable'))
    server.applyProgramStatusLifecycle(PANE, lifecycle('live'))
    expect(slotAt(PANE)).toBeNull()
  })

  it('after a clear, a stale ack refuses on the empty pane and cannot hide the new state', () => {
    const { server, rows, ingest, slotAt } = harness()
    ingest(report(1, view('done', 3)))
    ingest(report(2, null))
    expect(server.acknowledgeProgramStatus(PANE, ackOf(view('done', 3)))).toBe(false)
    ingest(report(3, view('done', 4)))
    const published = rows.length
    expect(server.acknowledgeProgramStatus(PANE, ackOf(view('done', 3)))).toBe(false)
    expect(rows).toHaveLength(published)
    expect(slotAt(PANE)?.shown.generation).toBe(4)
  })

  it('a retire then restore keeps it hidden, and a new incarnation shows', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('done', 3)))
    server.acknowledgeProgramStatus(PANE, ackOf(view('done', 3)))
    server.closeProgramStatusPane(PANE)
    server.reopenProgramStatusPane(PANE)
    ingest(report(1, view('done', 3)))
    expect(slotAt(PANE)).toBeNull()
    ingest(report(1, view('done', 3), 'live', NEXT_INCARNATION))
    expect(slotAt(PANE)?.incarnationId).toBe('inc-2')
  })

  it('a pane move keeps it hidden: the ack belongs to the PTY', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('done', 3)))
    server.acknowledgeProgramStatus(PANE, ackOf(view('done', 3)))
    server.rekeyProgramStatus(PANE, { paneKey: OTHER_PANE }, PTY, report(1, view('done', 3)))
    expect(slotAt(OTHER_PANE)).toBeNull()
  })

  it('a retired PTY drops its ack', () => {
    const { server, ingest, slotAt } = harness()
    ingest(report(1, view('done', 3)))
    server.acknowledgeProgramStatus(PANE, ackOf(view('done', 3)))
    server.forgetProgramStatus(PANE, PTY, { ptyRetired: true })
    ingest(report(1, view('done', 3)))
    expect(slotAt(PANE)?.shown.generation).toBe(3)
  })
})

describe('program-status slot: the exit carries the ack by ptyId before the closure', () => {
  const dismissedNow = view('done', 3)
  const sameOnExit = view('done', 4)
  const differentOnExit = view('error', 4)

  function dismissed() {
    const h = harness()
    h.ingest(report(1, dismissedNow))
    h.server.acknowledgeProgramStatus(PANE, ackOf(dismissedNow))
    return h
  }

  function exitThenResync(
    h: ReturnType<typeof harness>,
    onExit: ProgramStatusView,
    prevNow: ProgramStatusView,
    leave: 'close' | 'evict'
  ) {
    if (leave === 'close') {
      h.server.closeProgramStatusPane(PANE)
    } else {
      for (let index = 0; index < 500; index += 1) {
        h.ingest(
          report(1, view('working', 1), 'live', { ptyId: `filler-${index}`, incarnationId: 'f' }),
          `tab-fill:${index}`
        )
      }
      expect(h.slotAt(PANE)).toBeUndefined()
    }
    h.server.applyProgramStatusLifecycle(PANE, lifecycle('exited', { shown: onExit, prevNow }))
    h.server.reopenProgramStatusPane(PANE)
    h.ingest(report(2, onExit, 'exited'))
    return h.slotAt(PANE)
  }

  for (const leave of ['close', 'evict'] as const) {
    it(`same summary on exit: still hidden (${leave})`, () => {
      expect(exitThenResync(dismissed(), sameOnExit, dismissedNow, leave)).toBeNull()
    })

    it(`different summary on exit: visible (${leave})`, () => {
      const slot = exitThenResync(dismissed(), differentOnExit, dismissedNow, leave)
      expect(slot?.shown.summary.aggregate).toBe('error')
    })

    it(`coalesced working, done before the exit: visible (${leave})`, () => {
      const slot = exitThenResync(dismissed(), sameOnExit, view('done', 7), leave)
      expect(slot?.shown.generation).toBe(4)
    })
  }

  it('the slot write itself is still refused while closed', () => {
    const h = dismissed()
    h.server.closeProgramStatusPane(PANE)
    const accepted = h.server.applyProgramStatusLifecycle(
      PANE,
      lifecycle('exited', { shown: sameOnExit, prevNow: dismissedNow })
    )
    expect(accepted).toBe(false)
    expect(h.slotAt(PANE)).toBeUndefined()
  })
})

describe("program-status slot: the producer's proof of the `now` view the exit followed", () => {
  const hiddenNow = view('done', 3)
  const sameOnExit = view('done', 4)
  const exitedReport = (prevNow?: ProgramStatusView) => ({
    ...report(2, sameOnExit, 'exited'),
    ...(prevNow ? { prevNow } : {})
  })

  it('an exited write keeps the proof on the slot, and a later lifecycle without one keeps it', () => {
    const h = harness()
    h.ingest(report(1, hiddenNow))
    h.server.applyProgramStatusLifecycle(
      PANE,
      lifecycle('exited', { shown: sameOnExit, prevNow: hiddenNow })
    )
    expect(h.slotAt(PANE)?.exitedFrom).toEqual(hiddenNow)
    h.server.applyProgramStatusLifecycle(PANE, lifecycle('exited', {}, 300))
    expect(h.slotAt(PANE)?.exitedFrom).toEqual(hiddenNow)
    const fresh = harness()
    fresh.ingest(exitedReport(hiddenNow))
    expect(fresh.slotAt(PANE)?.exitedFrom).toEqual(hiddenNow)
  })

  it('a `now` ack that arrives after the exit is carried by the proof', () => {
    const h = harness()
    h.ingest(exitedReport(hiddenNow))
    expect(h.server.acknowledgeProgramStatus(PANE, ackOf(hiddenNow))).toBe(true)
    expect(h.slotAt(PANE)).toBeNull()
  })

  it.each([
    ['a proof of another generation', exitedReport(view('done', 7))],
    ['no proof at all', exitedReport()],
    ['a different summary on exit', { ...exitedReport(hiddenNow), shown: view('error', 4) }]
  ])('refuses a stale `now` ack against %s', (_name, write) => {
    const h = harness()
    h.ingest(write)
    expect(h.server.acknowledgeProgramStatus(PANE, ackOf(hiddenNow))).toBe(false)
    expect(h.slotAt(PANE)).not.toBeNull()
  })
})

describe('program-status slot: publication and bounds', () => {
  it('the listener replays current rows on install and stops on null', () => {
    const { server, ingest } = harness()
    ingest(report(1, view('working', 1)))
    ingest(report(1, view('done', 1), 'live', OTHER_PTY), OTHER_PANE)
    const replayed: ProgramStatusPaneIpcPayload[] = []
    server.setProgramStatusListener((row) => replayed.push(row))
    expect(replayed.map((row) => row.paneKey)).toEqual([PANE, OTHER_PANE])
    server.setProgramStatusListener(null)
    ingest(report(2, view('done', 2)))
    expect(replayed).toHaveLength(2)
  })

  it('a throwing listener does not stop the store', () => {
    const server = new AgentHookServer()
    server.setProgramStatusListener(() => {
      throw new Error('boom')
    })
    const errors: unknown[] = []
    const original = console.error
    console.error = (...args: unknown[]) => errors.push(args)
    try {
      server.ingestProgramStatusReport({ paneKey: PANE, write: report(1, view('working', 1)) })
    } finally {
      console.error = original
    }
    expect(errors).toHaveLength(1)
    expect(server.getProgramStatusSnapshot()).toHaveLength(1)
  })

  it('past 500 records a resting record is evicted before an older active one', () => {
    const { server, rows, ingest, slotAt } = harness()
    ingest(report(1, view('working', 1)), PANE)
    ingest(report(1, view('done', 1), 'live', OTHER_PTY), OTHER_PANE)
    for (let index = 0; index < 498; index += 1) {
      ingest(
        report(1, view('working', 1), 'live', { ptyId: `p-${index}`, incarnationId: 'i' }),
        `tab-fill:${index}`
      )
    }
    expect(server.getProgramStatusSnapshot()).toHaveLength(500)
    ingest(report(1, view('idle', 1), 'live', { ptyId: 'p-new', incarnationId: 'i' }), THIRD_PANE)
    expect(server.getProgramStatusSnapshot()).toHaveLength(500)
    expect(slotAt(OTHER_PANE)).toBeUndefined()
    expect(slotAt(PANE)).toBeDefined()
    expect(slotAt(THIRD_PANE)?.shown.summary.aggregate).toBe('idle')
    expect(rows.at(-1)).toMatchObject({ paneKey: OTHER_PANE, programStatus: null })
  })

  it('without a resting record the oldest is evicted', () => {
    const { server, ingest, slotAt } = harness()
    for (let index = 0; index < 500; index += 1) {
      ingest(
        report(1, view('working', 1), 'live', { ptyId: `p-${index}`, incarnationId: 'i' }),
        `tab-fill:${index}`
      )
    }
    ingest(report(1, view('working', 1)), PANE)
    expect(server.getProgramStatusSnapshot()).toHaveLength(500)
    expect(slotAt('tab-fill:0')).toBeUndefined()
    expect(slotAt(PANE)).toBeDefined()
  })
})
