import { describe, expect, it } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { MAX_AGENT_HOOK_STATUS_CACHE_PANES } from '../../shared/agent-hook-status-cache'
import { programStatusEntryFromSlot } from '../../shared/program-status/compose-agent-status-entry'
import { composedEntryStaleAt } from '../../shared/program-status/program-status-expiry'
import type {
  ProgramStatusFact,
  ProgramStatusSummaryState,
  ProgramStatusView
} from '../../shared/program-status/program-status-slot'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from '../agent-hooks/server'
import { LEAF_1, LEAF_2, LEAF_3 } from '../agent-hooks/server.test-fixtures'
import {
  applyProgramStatusFact,
  createProgramStatusLedger,
  exitProgramStatusLedger,
  loseProgramStatusLedger,
  programStatusLedgerLifecycle,
  programStatusLedgerReport,
  reconnectProgramStatusLedger,
  registerProgramStatusIncarnation
} from './program-status-ledger'
import {
  createProgramStatusIngress,
  type ProgramStatusIngressTarget,
  type ProgramStatusSink
} from './program-status-ingress'
import { createProgramStatusLocalIngest } from './program-status-local-ingest'

const PANE = makePaneKey('tab-1', LEAF_1)
const OTHER_PANE = makePaneKey('tab-2', LEAF_2)
const THIRD_PANE = makePaneKey('tab-3', LEAF_3)
const PTY = 'pty-1'
const MINUTE = 60_000

function view(aggregate: ProgramStatusSummaryState, generation: number): ProgramStatusView {
  return {
    summary: { aggregate, root: aggregate, childError: false },
    generation,
    changedAt: 500,
    rootChangedAt: 500
  }
}

function fact(
  reportSeq: number,
  now: ProgramStatusView | null,
  onExit: ProgramStatusView | null = now,
  incarnationId = 'inc-1'
): ProgramStatusFact {
  return { incarnationId, reportSeq, observation: { now, onExit } }
}

const EMPTY_SNAPSHOT = fact(0, null)
const report = (body: string): string => `\x1b]7501;${body}\x07`

/** The production sink shape, over a real hook server; `ops` records which operation ran. */
function harness() {
  const server = new AgentHookServer()
  const rows: { paneKey: string; tombstone: boolean }[] = []
  server.setProgramStatusListener((row) =>
    rows.push({ paneKey: row.paneKey, tombstone: row.programStatus === null })
  )
  const ops: string[] = []
  const sink: ProgramStatusSink = {
    report: (target, write) => (
      ops.push('report'),
      server.ingestProgramStatusReport({ ...target, write })
    ),
    lifecycle: (paneKey, write) => (
      ops.push(`lifecycle:${write.liveness}`),
      server.applyProgramStatusLifecycle(paneKey, write)
    ),
    rekey: (from, to, identity, current) => (
      ops.push('rekey'),
      server.rekeyProgramStatus(from, to, identity, current)
    ),
    forget: (paneKey, identity, options) => (
      ops.push('forget'),
      server.forgetProgramStatus(paneKey, identity, options)
    )
  }
  const targets = new Map<string, ProgramStatusIngressTarget>([
    [PTY, { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }]
  ])
  let clock = 1_000
  const ingress = createProgramStatusIngress({
    sink,
    resolveTarget: (ptyId) => targets.get(ptyId),
    resolvePaneKey: (paneKey) => server.resolveProgramStatusPaneKey(paneKey),
    now: () => clock
  })
  const slotAt = (paneKey: string) =>
    server.getProgramStatusSnapshot().find((row) => row.paneKey === paneKey)
  const visibleAt = (paneKey: string) => slotAt(paneKey)?.programStatus ?? undefined
  // Why: a hidden record still publishes its row, with no slot in it.
  const hiddenAt = (paneKey: string) => slotAt(paneKey)?.programStatus === null
  const ackShown = (paneKey: string) => {
    const slot = slotAt(paneKey)!.programStatus!
    const ack = {
      incarnationId: slot.incarnationId,
      view: slot.view,
      generation: slot.shown.generation
    }
    expect(server.acknowledgeProgramStatus(paneKey, ack)).toBe(true)
  }
  const reset = () => {
    rows.length = 0
    ops.length = 0
  }
  const always = () => true
  return {
    server,
    rows,
    ops,
    targets,
    ingress,
    slotAt,
    visibleAt,
    hiddenAt,
    ackShown,
    reset,
    always,
    setClock: (at: number) => (clock = at)
  }
}

describe('program-status ledger: the lifecycle event table', () => {
  const registered = () =>
    registerProgramStatusIncarnation(createProgramStatusLedger(PTY, 10), EMPTY_SNAPSHOT, 10).ledger

  it('turns a fact with a greater reportSeq into a report of the phase view, minting nothing', () => {
    const step = applyProgramStatusFact(registered(), fact(3, view('working', 1)))
    expect(step.report).toEqual({
      kind: 'report',
      identity: { ptyId: PTY, incarnationId: 'inc-1' },
      reportSeq: 3,
      shown: view('working', 1),
      liveness: 'live',
      livenessChangedAt: 10
    })
    expect(step.lifecycle).toBeUndefined()
  })

  it('drops an equal or lower reportSeq and any fact of another incarnation', () => {
    const ledger = applyProgramStatusFact(registered(), fact(3, view('working', 1))).ledger
    for (const late of [
      fact(3, view('done', 2)),
      fact(2, view('done', 2)),
      fact(9, null, null, 'inc-0')
    ]) {
      const step = applyProgramStatusFact(ledger, late)
      expect(step.ledger).toBe(ledger)
      expect(step.report).toBeUndefined()
    }
  })

  it('holds early facts per incarnation and registration adopts the greater of snapshot and pending', () => {
    let ledger = createProgramStatusLedger(PTY, 10)
    for (const early of [
      fact(2, view('working', 1), null, 'inc-a'),
      fact(1, view('idle', 1), null, 'inc-a'),
      fact(5, view('done', 4), null, 'inc-b'),
      fact(7, view('error', 6), null, 'inc-c')
    ]) {
      const step = applyProgramStatusFact(ledger, early)
      expect(step.report).toBeUndefined()
      ledger = step.ledger
    }
    // Why: at most two incarnations wait; the oldest went first.
    expect(ledger.pending.map((held) => held.incarnationId)).toEqual(['inc-b', 'inc-c'])
    const adopted = registerProgramStatusIncarnation(
      ledger,
      fact(4, view('idle', 2), null, 'inc-b'),
      20
    )
    expect(adopted.ledger).toMatchObject({ incarnationId: 'inc-b', reportSeq: 5, pending: [] })
    expect(adopted.report?.shown).toEqual(view('done', 4))
    const snapshotWins = registerProgramStatusIncarnation(
      ledger,
      fact(9, view('idle', 8), null, 'inc-c'),
      20
    )
    expect(snapshotWins.ledger).toMatchObject({ reportSeq: 9, pending: [] })
  })

  it('certified exit: exited at the event, onExit shown, prevNow carried, never repeated', () => {
    const ledger = applyProgramStatusFact(
      registered(),
      fact(3, view('working', 1), view('done', 2))
    ).ledger
    const step = exitProgramStatusLedger(ledger, 50)
    expect(step.ledger).toMatchObject({ phase: 'exited', phaseChangedAt: 50, reportSeq: 3 })
    expect(step.lifecycle).toEqual({
      kind: 'lifecycle',
      identity: { ptyId: PTY, incarnationId: 'inc-1' },
      liveness: 'exited',
      livenessChangedAt: 50,
      shown: view('done', 2),
      prevNow: view('working', 1)
    })
    expect(exitProgramStatusLedger(step.ledger, 60)).toEqual({ ledger: step.ledger })
  })

  it('a fact delayed past the exit becomes an exited report of its onExit view', () => {
    const exited = exitProgramStatusLedger(registered(), 50).ledger
    const step = applyProgramStatusFact(exited, fact(4, view('working', 3), view('done', 4)))
    expect(step.report).toMatchObject({
      reportSeq: 4,
      shown: view('done', 4),
      liveness: 'exited',
      livenessChangedAt: 50
    })
  })

  it("every exited write proves the `now` view the exit followed: the producer's last one", () => {
    const live = applyProgramStatusFact(
      registered(),
      fact(3, view('done', 1), view('done', 2))
    ).ledger
    expect(programStatusLedgerReport(live)).not.toHaveProperty('prevNow')
    expect(programStatusLedgerLifecycle(live)).not.toHaveProperty('prevNow')
    const exited = exitProgramStatusLedger(live, 50).ledger
    expect(programStatusLedgerReport(exited)).toMatchObject({ prevNow: view('done', 1) })
    expect(programStatusLedgerLifecycle(exited)).toMatchObject({ prevNow: view('done', 1) })
    const late = applyProgramStatusFact(exited, fact(4, view('working', 3), view('done', 4)))
    expect(late.report).toMatchObject({ prevNow: view('working', 3), shown: view('done', 4) })
  })

  it('unconfirmed loss starts the window once, and never after an exit', () => {
    const lost = loseProgramStatusLedger(registered(), 30)
    expect(lost.ledger).toMatchObject({ phase: 'unverifiable', phaseChangedAt: 30 })
    expect(lost.lifecycle).toMatchObject({ liveness: 'unverifiable', livenessChangedAt: 30 })
    expect(lost.lifecycle).not.toHaveProperty('shown')
    expect(loseProgramStatusLedger(lost.ledger, 40)).toEqual({ ledger: lost.ledger })
    const exited = exitProgramStatusLedger(lost.ledger, 45).ledger
    expect(loseProgramStatusLedger(exited, 50)).toEqual({ ledger: exited })
  })

  it('reconnect: the newer snapshot first, then back to live; exited stays exited', () => {
    const lost = loseProgramStatusLedger(
      applyProgramStatusFact(registered(), fact(3, view('working', 1))).ledger,
      30
    ).ledger
    const newer = reconnectProgramStatusLedger(lost, fact(5, view('done', 4)), 70)
    expect(newer.report).toMatchObject({
      reportSeq: 5,
      liveness: 'unverifiable',
      livenessChangedAt: 30
    })
    expect(newer.lifecycle).toMatchObject({ liveness: 'live', livenessChangedAt: 70 })
    const equal = reconnectProgramStatusLedger(lost, fact(3, view('working', 1)), 70)
    expect(equal.report).toBeUndefined()
    expect(equal.lifecycle).toMatchObject({ liveness: 'live' })
    const exited = exitProgramStatusLedger(lost, 40).ledger
    const late = reconnectProgramStatusLedger(
      exited,
      fact(4, view('working', 3), view('done', 4)),
      70
    )
    expect(late.lifecycle).toBeUndefined()
    expect(late.report).toMatchObject({ liveness: 'exited', shown: view('done', 4) })
    const live = applyProgramStatusFact(registered(), fact(3, view('working', 1))).ledger
    expect(
      reconnectProgramStatusLedger(live, fact(3, view('working', 1)), 70).lifecycle
    ).toBeUndefined()
  })

  it('a replaced incarnation starts a fresh live ledger and names the identity it replaced', () => {
    const exited = exitProgramStatusLedger(registered(), 50).ledger
    const step = registerProgramStatusIncarnation(
      exited,
      fact(1, view('idle', 1), null, 'inc-2'),
      80
    )
    expect(step.ledger).toMatchObject({ incarnationId: 'inc-2', phase: 'live', phaseChangedAt: 80 })
    expect(step.replaced).toEqual({ ptyId: PTY, incarnationId: 'inc-1' })
  })
})

describe('program-status ingress into the hook server store', () => {
  it('keeps an unattributed PTY unpublished until attribution resolves, then publishes once', () => {
    const h = harness()
    h.targets.delete(PTY)
    h.ingress.register(PTY, EMPTY_SNAPSHOT)
    h.ingress.fact(PTY, fact(1, view('working', 1)))
    h.ingress.settle(PTY)
    expect(h.rows).toEqual([])
    h.targets.set(PTY, { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' })
    h.ingress.settle(PTY)
    h.ingress.settle(PTY)
    expect(h.rows).toEqual([{ paneKey: PANE, tombstone: false }])
    expect(h.slotAt(PANE)).toMatchObject({ tabId: 'tab-1', worktreeId: 'wt-1' })
  })

  it('a local PTY whose pane resolves after its report publishes on its next chunk', () => {
    const h = harness()
    h.targets.delete(PTY)
    const local = createProgramStatusLocalIngest(h.ingress)
    local.begin(PTY, 'inc-1')
    local.observe(PTY, report('state=working'), 2_000)
    expect(h.rows).toEqual([])
    h.targets.set(PTY, { paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' })
    local.observe(PTY, 'plain output', 2_100)
    expect(h.visibleAt(PANE)?.shown.summary.aggregate).toBe('working')
  })

  it('an attribution move rekeys, with the current report as fallback, and keeps the dismissal', () => {
    const h = harness()
    h.ingress.register(PTY, EMPTY_SNAPSHOT)
    h.ingress.fact(PTY, fact(1, view('done', 1)))
    h.ackShown(PANE)
    h.targets.set(PTY, { paneKey: OTHER_PANE, tabId: 'tab-2', worktreeId: 'wt-1' })
    h.reset()
    h.ingress.settle(PTY)
    h.ingress.fact(PTY, fact(1, view('done', 1)))
    expect(h.slotAt(PANE)).toBeUndefined()
    expect(h.hiddenAt(OTHER_PANE)).toBe(true)
    // Fallback: the source pane's closure already forgot the record.
    h.server.closeProgramStatusPane(OTHER_PANE)
    h.targets.set(PTY, { paneKey: THIRD_PANE, tabId: 'tab-3', worktreeId: 'wt-1' })
    h.reset()
    h.ingress.fact(PTY, fact(2, view('done', 1)))
    expect(h.ops.slice(0, 1)).toEqual(['rekey'])
    expect(h.hiddenAt(THIRD_PANE)).toBe(true)
  })

  it('a new incarnation replaces the slot, or forgets the old one when it shows nothing', () => {
    const h = harness()
    h.ingress.register(PTY, EMPTY_SNAPSHOT)
    h.ingress.fact(PTY, fact(1, view('done', 1)))
    h.ingress.register(PTY, fact(1, view('working', 1), null, 'inc-2'))
    expect(h.slotAt(PANE)?.programStatus).toMatchObject({ incarnationId: 'inc-2', reportSeq: 1 })
    h.reset()
    h.ingress.register(PTY, fact(0, null, null, 'inc-3'))
    expect(h.slotAt(PANE)).toBeUndefined()
    expect(h.ops).toContain('forget')
    // A late fact of a replaced incarnation is dropped by its id.
    h.ingress.fact(PTY, fact(9, view('error', 9), null, 'inc-2'))
    expect(h.slotAt(PANE)).toBeUndefined()
  })

  it('certified exit keeps done and error on the open pane and drops working', () => {
    const h = harness()
    const local = createProgramStatusLocalIngest(h.ingress)
    local.begin(PTY, 'inc-1')
    local.observe(PTY, report('state=working') + report('state=done:id=child'), 2_000)
    expect(h.visibleAt(PANE)?.shown.summary.aggregate).toBe('working')
    local.exit(PTY, true)
    expect(h.visibleAt(PANE)).toMatchObject({ liveness: 'exited', view: 'onExit' })
    expect(h.visibleAt(PANE)?.shown.summary).toMatchObject({ aggregate: 'done', root: null })

    const working = harness()
    const onlyWorking = createProgramStatusLocalIngest(working.ingress)
    onlyWorking.begin(PTY, 'inc-1')
    onlyWorking.observe(PTY, report('state=working'), 2_000)
    onlyWorking.exit(PTY, true)
    expect(working.slotAt(PANE)).toBeUndefined()
    expect(working.rows.at(-1)).toEqual({ paneKey: PANE, tombstone: true })
  })

  it('exit flushes a coalesced state the throttle still held, so onExit is the last report', () => {
    const h = harness()
    const timers = { setTimeout: () => ({}), clearTimeout: () => {} }
    const local = createProgramStatusLocalIngest(h.ingress, { timers, monotonicNow: () => 0 })
    local.begin(PTY, 'inc-1')
    // Ten distinct changes: the burst of eight goes out, the last two wait for a token.
    const burst = Array.from({ length: 9 }, (_, index) =>
      report(`state=${index % 2 === 0 ? 'working' : 'blocked'}`)
    ).concat(report('state=error:id=child'))
    for (const chunk of burst) {
      local.observe(PTY, chunk, 2_000)
    }
    local.exit(PTY, true)
    // Why `done`: a child's error marks `childError`, only the root can fail the aggregate.
    expect(h.visibleAt(PANE)?.shown.summary).toEqual({
      aggregate: 'done',
      root: null,
      childError: true
    })
  })

  it('an uncertified loss keeps the view and marks it unverifiable; untracked PTYs cost nothing', () => {
    const h = harness()
    const local = createProgramStatusLocalIngest(h.ingress)
    local.observe('pty-untracked', report('state=working'), 2_000)
    local.exit('pty-untracked', true)
    expect(h.rows).toEqual([])
    local.begin(PTY, 'inc-1')
    local.observe(PTY, report('state=done'), 2_000)
    h.setClock(5_000)
    local.exit(PTY, false)
    expect(h.visibleAt(PANE)).toMatchObject({ liveness: 'unverifiable', livenessChangedAt: 5_000 })
    expect(h.visibleAt(PANE)?.shown.summary.aggregate).toBe('done')
  })

  it('every write while the pane is closed is refused, and the ledger keeps the result', () => {
    const h = harness()
    h.ingress.register(PTY, EMPTY_SNAPSHOT)
    h.ingress.fact(PTY, fact(1, view('working', 1)))
    h.server.closeProgramStatusPane(PANE)
    h.reset()
    h.ingress.fact(PTY, fact(2, view('done', 2), view('done', 2)))
    h.ingress.lost(PTY)
    h.ingress.reconnected(PTY, fact(2, view('done', 2), view('done', 2)))
    expect(h.rows).toEqual([])
    h.server.reopenProgramStatusPane(PANE)
    h.ingress.resyncPane(PANE, PTY, h.always)
    expect(h.visibleAt(PANE)).toMatchObject({ reportSeq: 2, liveness: 'live' })
  })

  it('prune forgets the slot with the PTY retired, deleting its acknowledgement', () => {
    const h = harness()
    h.ingress.register(PTY, EMPTY_SNAPSHOT)
    h.ingress.fact(PTY, fact(1, view('done', 1)))
    h.ackShown(PANE)
    h.ingress.prune(PTY)
    expect(h.slotAt(PANE)).toBeUndefined()
    // The same identity re-reported by a fresh ledger shows: the ack went with the PTY.
    h.ingress.register(PTY, fact(1, view('done', 1)))
    expect(h.visibleAt(PANE)?.shown.summary.aggregate).toBe('done')
  })
})

describe('program-status ingress: dismissal across the exit of a PTY detached from its pane', () => {
  /** X is dismissed at PANE, Y takes PANE over and reports, X exits detached, then lands elsewhere. */
  function detachedExit(onExit: ProgramStatusSummaryState) {
    const h = harness()
    h.ingress.register(PTY, fact(1, view('done', 1), view(onExit, 2)))
    h.ackShown(PANE)
    h.targets.set('pty-2', { paneKey: PANE })
    h.ingress.register('pty-2', fact(0, null, null, 'inc-2'))
    h.ingress.resyncPane(PANE, 'pty-2', h.always)
    h.ingress.fact('pty-2', fact(1, view('working', 1), null, 'inc-2'))
    const owner = h.visibleAt(PANE)
    h.ingress.exited(PTY)
    return { h, owner }
  }

  it('carries the dismissal, so the same result does not come back on a later resync', () => {
    const { h } = detachedExit('done')
    h.ingress.resyncPane(OTHER_PANE, PTY, h.always)
    expect(h.hiddenAt(OTHER_PANE)).toBe(true)
  })

  it("leaves the new owner's slot exactly as it was", () => {
    const { h, owner } = detachedExit('done')
    expect(owner).toMatchObject({ ptyId: 'pty-2', liveness: 'live' })
    expect(h.visibleAt(PANE)).toEqual(owner)
  })

  it('still shows a different onExit summary', () => {
    const { h } = detachedExit('error')
    h.ingress.resyncPane(OTHER_PANE, PTY, h.always)
    expect(h.visibleAt(OTHER_PANE)).toMatchObject({ liveness: 'exited', view: 'onExit' })
  })
})

describe('program-status ingress: dismissal across an exit while closed', () => {
  type Removal = 'closed' | 'evicted'
  const removePane = (h: ReturnType<typeof harness>, removal: Removal) => {
    if (removal === 'closed') {
      h.server.closeProgramStatusPane(PANE)
      return
    }
    for (let index = 0; index < MAX_AGENT_HOOK_STATUS_CACHE_PANES; index += 1) {
      h.server.ingestProgramStatusReport({
        paneKey: makePaneKey(`tab-fill-${index}`, LEAF_2),
        write: {
          kind: 'report',
          identity: { ptyId: `fill-${index}`, incarnationId: 'fill' },
          reportSeq: 1,
          shown: view('done', 1),
          liveness: 'live',
          livenessChangedAt: 1
        }
      })
    }
    expect(h.slotAt(PANE)).toBeUndefined()
  }

  /** Dismiss `done`, optionally coalesce, remove the pane, certify the exit, then resync. */
  function scenario(removal: Removal, onExit: ProgramStatusSummaryState, coalesced: boolean) {
    const h = harness()
    h.ingress.register(PTY, EMPTY_SNAPSHOT)
    h.ingress.fact(PTY, fact(1, view('done', 1), view(onExit, 6)))
    h.ackShown(PANE)
    if (coalesced) {
      // The tracker saw `working, done` inside one window: same summary, newer generation.
      h.ingress.fact(PTY, fact(2, view('done', 5), view(onExit, 6)))
    }
    removePane(h, removal)
    h.ingress.exited(PTY)
    if (removal === 'closed') {
      h.server.reopenProgramStatusPane(PANE)
    }
    h.ingress.resyncPane(PANE, PTY, h.always)
    return h
  }

  for (const removal of ['closed', 'evicted'] as const) {
    it(`${removal}: an equal onExit summary stays hidden`, () => {
      expect(scenario(removal, 'done', false).hiddenAt(PANE)).toBe(true)
    })

    it(`${removal}: a different onExit summary shows`, () => {
      const h = scenario(removal, 'error', false)
      expect(h.visibleAt(PANE)).toMatchObject({ liveness: 'exited', view: 'onExit' })
    })

    it(`${removal}: a coalesced transition between dismissal and exit shows`, () => {
      expect(scenario(removal, 'done', true).visibleAt(PANE)).toMatchObject({ view: 'onExit' })
    })
  }
})

describe('program-status ingress: the expiry instant belongs to the ledger', () => {
  const T = 10 * MINUTE
  const staleAt = (h: ReturnType<typeof harness>, paneKey: string) => {
    const slot = h.slotAt(paneKey)!.programStatus!
    return composedEntryStaleAt(programStatusEntryFromSlot({ paneKey, slot }))
  }

  it('unverifiable at T, retire at T+10, restore at T+20: still stale at T+30', () => {
    const h = harness()
    h.ingress.register(PTY, EMPTY_SNAPSHOT)
    h.ingress.fact(PTY, fact(1, view('working', 1)))
    h.setClock(T)
    h.ingress.lost(PTY)
    h.setClock(T + 10 * MINUTE)
    h.server.closeProgramStatusPane(PANE)
    h.setClock(T + 20 * MINUTE)
    h.server.reopenProgramStatusPane(PANE)
    h.ingress.resyncPane(PANE, PTY, h.always)
    expect(staleAt(h, PANE)).toBe(T + AGENT_STATUS_STALE_AFTER_MS)
  })

  it('the rekey fallback and a re-creation after eviction keep the same instant', () => {
    const h = harness()
    h.ingress.register(PTY, EMPTY_SNAPSHOT)
    h.ingress.fact(PTY, fact(1, view('working', 1)))
    h.setClock(T)
    h.ingress.lost(PTY)
    h.server.closeProgramStatusPane(PANE)
    h.setClock(T + 20 * MINUTE)
    h.targets.set(PTY, { paneKey: OTHER_PANE, tabId: 'tab-2', worktreeId: 'wt-1' })
    h.ingress.settle(PTY)
    expect(h.ops).toContain('rekey')
    expect(staleAt(h, OTHER_PANE)).toBe(T + AGENT_STATUS_STALE_AFTER_MS)
    h.server.forgetProgramStatus(OTHER_PANE, { ptyId: PTY, incarnationId: 'inc-1' })
    h.ingress.resyncPane(OTHER_PANE, PTY, h.always)
    expect(staleAt(h, OTHER_PANE)).toBe(T + AGENT_STATUS_STALE_AFTER_MS)
  })
})
