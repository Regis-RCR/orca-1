import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  ProgramStatusAck,
  ProgramStatusIdentity,
  ProgramStatusLifecycleWrite,
  ProgramStatusLiveness,
  ProgramStatusReportWrite,
  ProgramStatusSlot,
  ProgramStatusView
} from './program-status-slot'
import {
  applyProgramStatusWrite,
  carryAckAcrossExit,
  isProgramStatusSlotHidden
} from './program-status-slot-transition'
import {
  createProgramStatusTracker,
  type ProgramStatusTrackerState
} from './program-status-tracker'

const PTY: ProgramStatusIdentity = { ptyId: 'pty-1', incarnationId: 'inc-1' }
const NEXT_INCARNATION: ProgramStatusIdentity = { ptyId: 'pty-1', incarnationId: 'inc-2' }

const view = (
  generation: number,
  overrides: Partial<ProgramStatusView> = {}
): ProgramStatusView => ({
  summary: { aggregate: 'done', root: 'done', childError: false },
  generation,
  changedAt: 500,
  rootChangedAt: 500,
  ...overrides
})

function reportWrite(
  reportSeq: number,
  shown: ProgramStatusView | null,
  liveness: ProgramStatusLiveness = 'live',
  livenessChangedAt = 100,
  identity: ProgramStatusIdentity = PTY
): ProgramStatusReportWrite {
  return { kind: 'report', identity, reportSeq, shown, liveness, livenessChangedAt }
}

function lifecycleWrite(
  liveness: ProgramStatusLiveness,
  livenessChangedAt: number,
  extra: Partial<ProgramStatusLifecycleWrite> = {}
): ProgramStatusLifecycleWrite {
  return { kind: 'lifecycle', identity: PTY, liveness, livenessChangedAt, ...extra }
}

function slotFrom(write: ProgramStatusReportWrite): ProgramStatusSlot {
  const { next } = applyProgramStatusWrite(undefined, write)
  if (!next) {
    throw new Error('expected a slot')
  }
  return next
}

function ackOf(slot: ProgramStatusSlot): ProgramStatusAck {
  return { incarnationId: slot.incarnationId, view: slot.view, generation: slot.shown.generation }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('applyProgramStatusWrite: reports', () => {
  it('accepts a report on an empty pane, deriving view and copying the times', () => {
    expect(applyProgramStatusWrite(undefined, reportWrite(3, view(2), 'live', 777))).toEqual({
      accepted: true,
      next: {
        ...PTY,
        reportSeq: 3,
        liveness: 'live',
        livenessChangedAt: 777,
        view: 'now',
        shown: view(2)
      }
    })
  })

  it('accepts a null shown on an empty pane and leaves it empty', () => {
    expect(applyProgramStatusWrite(undefined, reportWrite(3, null))).toEqual({
      accepted: true,
      next: undefined
    })
  })

  it('accepts another incarnation as a replacement, whatever its reportSeq', () => {
    const prev = slotFrom(reportWrite(900, view(40), 'exited'))
    const { accepted, next } = applyProgramStatusWrite(
      prev,
      reportWrite(1, view(1), 'live', 200, NEXT_INCARNATION)
    )
    expect(accepted).toBe(true)
    expect(next).toMatchObject({ incarnationId: 'inc-2', reportSeq: 1, liveness: 'live' })
  })

  it('refuses an equal or lower reportSeq of the stored incarnation, keeping the slot', () => {
    const prev = slotFrom(reportWrite(5, view(4)))
    for (const seq of [5, 4]) {
      const result = applyProgramStatusWrite(prev, reportWrite(seq, view(9)))
      expect(result.accepted).toBe(false)
      expect(result.next).toBe(prev)
    }
    expect(applyProgramStatusWrite(prev, reportWrite(6, view(9))).accepted).toBe(true)
  })

  it('refuses a non-exited report onto an exited slot, and accepts an exited one', () => {
    const prev = slotFrom(reportWrite(5, view(4), 'exited'))
    expect(applyProgramStatusWrite(prev, reportWrite(6, view(5), 'live')).accepted).toBe(false)
    expect(applyProgramStatusWrite(prev, reportWrite(6, view(5), 'unverifiable')).accepted).toBe(
      false
    )
    expect(applyProgramStatusWrite(prev, reportWrite(6, view(5), 'exited')).next).toMatchObject({
      reportSeq: 6,
      view: 'onExit'
    })
  })

  it('removes the slot on an accepted report with a null shown', () => {
    const prev = slotFrom(reportWrite(5, view(4)))
    expect(applyProgramStatusWrite(prev, reportWrite(6, null))).toEqual({
      accepted: true,
      next: undefined
    })
  })
})

describe('applyProgramStatusWrite: lifecycle', () => {
  it('refuses an empty pane and another identity, never reading reportSeq', () => {
    expect(applyProgramStatusWrite(undefined, lifecycleWrite('unverifiable', 1))).toEqual({
      accepted: false,
      next: undefined
    })
    const prev = slotFrom(reportWrite(5, view(4)))
    for (const identity of [NEXT_INCARNATION, { ptyId: 'pty-2', incarnationId: 'inc-1' }]) {
      const result = applyProgramStatusWrite(prev, { ...lifecycleWrite('exited', 1), identity })
      expect(result).toEqual({ accepted: false, next: prev })
    }
  })

  it('keeps the view and reportSeq when shown is omitted (link loss, reconnect)', () => {
    const prev = slotFrom(reportWrite(5, view(4)))
    const lost = applyProgramStatusWrite(prev, lifecycleWrite('unverifiable', 200)).next
    expect(lost).toMatchObject({ reportSeq: 5, liveness: 'unverifiable', livenessChangedAt: 200 })
    expect(lost?.shown).toBe(prev.shown)
    const back = lost && applyProgramStatusWrite(lost, lifecycleWrite('live', 300)).next
    expect(back).toMatchObject({ liveness: 'live', livenessChangedAt: 300, view: 'now' })
  })

  it('replaces the view on exit and removes the slot when onExit is null', () => {
    const prev = slotFrom(reportWrite(5, view(4)))
    const exited = applyProgramStatusWrite(prev, lifecycleWrite('exited', 400, { shown: view(5) }))
    expect(exited.next).toMatchObject({ liveness: 'exited', view: 'onExit', reportSeq: 5 })
    expect(exited.next?.shown).toEqual(view(5))
    expect(applyProgramStatusWrite(prev, lifecycleWrite('exited', 400, { shown: null }))).toEqual({
      accepted: true,
      next: undefined
    })
  })

  it('treats exited as absorbing for lifecycle writes', () => {
    const prev = slotFrom(reportWrite(5, view(4), 'exited'))
    expect(applyProgramStatusWrite(prev, lifecycleWrite('live', 500)).accepted).toBe(false)
    expect(applyProgramStatusWrite(prev, lifecycleWrite('unverifiable', 500)).accepted).toBe(false)
  })

  it('accepts a lifecycle write that changes nothing, as a new slot object', () => {
    for (const liveness of ['live', 'unverifiable', 'exited'] as const) {
      const prev = slotFrom(reportWrite(5, view(4), liveness, 100))
      const result = applyProgramStatusWrite(prev, lifecycleWrite(liveness, 100))
      expect(result.accepted).toBe(true)
      expect(result.next).toEqual(prev)
      expect(result.next).not.toBe(prev)
    }
  })
})

describe('applyProgramStatusWrite: the liveness time comes from the write, never a clock', () => {
  it('keeps the carried livenessChangedAt T on every create, never reading a clock', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('read a clock')
    })
    const created = applyProgramStatusWrite(undefined, reportWrite(1, view(1), 'unverifiable', 42))
    expect(created.next?.livenessChangedAt).toBe(42)
    const replaced = applyProgramStatusWrite(
      slotFrom(reportWrite(9, view(9), 'live', 7)),
      reportWrite(1, view(1), 'exited', 42, NEXT_INCARNATION)
    )
    expect(replaced.next?.livenessChangedAt).toBe(42)
    const updated = applyProgramStatusWrite(created.next, reportWrite(2, view(2), 'live', 99))
    expect(updated.next?.livenessChangedAt).toBe(99)
  })
})

describe('isProgramStatusSlotHidden', () => {
  it('hides exactly the acknowledged incarnation, view and generation', () => {
    const slot = slotFrom(reportWrite(5, view(4)))
    expect(isProgramStatusSlotHidden(slot, ackOf(slot))).toBe(true)
    expect(isProgramStatusSlotHidden(slot, undefined)).toBe(false)
    expect(isProgramStatusSlotHidden(slot, { ...ackOf(slot), generation: 3 })).toBe(false)
    expect(isProgramStatusSlotHidden(slot, { ...ackOf(slot), view: 'onExit' })).toBe(false)
    expect(isProgramStatusSlotHidden(slot, { ...ackOf(slot), incarnationId: 'inc-2' })).toBe(false)
  })
})

describe('carryAckAcrossExit', () => {
  const dismissed = view(4)
  const ack: ProgramStatusAck = { incarnationId: 'inc-1', view: 'now', generation: 4 }

  it('carries an exact match whose onExit summary is equal to the onExit generation', () => {
    expect(carryAckAcrossExit(ack, PTY, dismissed, view(6))).toEqual({
      incarnationId: 'inc-1',
      view: 'onExit',
      generation: 6
    })
  })

  it.each([
    [
      'a different onExit summary',
      ack,
      dismissed,
      view(6, { summary: { aggregate: 'error', root: 'error', childError: false } })
    ],
    ['a coalesced transition (ack older than prevNow)', ack, view(8), view(9)],
    ['no onExit view', ack, dismissed, null],
    ['no prevNow', ack, null, view(6)],
    ['another incarnation', { ...ack, incarnationId: 'inc-0' }, dismissed, view(6)],
    ['an ack of the onExit view', { ...ack, view: 'onExit' as const }, dismissed, view(6)]
  ])('leaves the ack unchanged for %s', (_name, given, prevNow, onExit) => {
    expect(carryAckAcrossExit(given, PTY, prevNow, onExit)).toBe(given)
  })

  it('returns undefined without an ack', () => {
    expect(carryAckAcrossExit(undefined, PTY, dismissed, view(6))).toBeUndefined()
  })
})

// The tracker produces the views, as it does for the ingress, so generations are real.
function trackerHarness() {
  const tracker = createProgramStatusTracker({ emit: () => undefined })
  let seq = 0
  const feed = (body: string, now: number): ProgramStatusTrackerState => {
    const data = `\x1b]7501;${body}\x07`
    tracker.observe(data, seq, now)
    seq += data.length
    return tracker.snapshot()
  }
  const write = (
    state: ProgramStatusTrackerState,
    liveness: ProgramStatusLiveness = 'live'
  ): ProgramStatusReportWrite => {
    const shown = liveness === 'exited' ? state.observation.onExit : state.observation.now
    return reportWrite(state.reportSeq, shown, liveness)
  }
  return { tracker, feed, write }
}

/** Applies a write and asserts it was accepted. */
function accept(
  prev: ProgramStatusSlot | undefined,
  write: ProgramStatusReportWrite | ProgramStatusLifecycleWrite
) {
  const result = applyProgramStatusWrite(prev, write)
  expect(result.accepted).toBe(true)
  return result.next
}

describe('dismissal identity through the tracker', () => {
  it('shows a coalesced working then done after a dismissed done', () => {
    const { feed, write } = trackerHarness()
    const slot = accept(undefined, write(feed('state=done', 1000)))
    const dismissal = slot && ackOf(slot)
    feed('state=working', 1001)
    const coalesced = feed('state=done', 1002)
    const next = accept(slot, write(coalesced))
    expect(next?.shown.summary).toEqual(slot?.shown.summary)
    expect(next && isProgramStatusSlotHidden(next, dismissal)).toBe(false)
  })

  it('shows a report after clear, and the stale ack hides nothing', () => {
    const { feed, write } = trackerHarness()
    const slot = accept(undefined, write(feed('state=done', 1000)))
    const stale = slot && ackOf(slot)
    expect(accept(slot, write(feed('state=clear', 1001)))).toBeUndefined()
    const again = accept(undefined, write(feed('state=done', 1002)))
    expect(again && isProgramStatusSlotHidden(again, stale)).toBe(false)
  })

  it('keeps a dismissal across snapshots, reconnects, link loss and an onExit-only change', () => {
    const { feed, write } = trackerHarness()
    feed('state=working', 1000)
    const first = feed('state=working:id=a', 1001)
    const slot = accept(undefined, write(first))
    const dismissal = slot && ackOf(slot)
    const snapshotAgain = slot && applyProgramStatusWrite(slot, write(first))
    expect(snapshotAgain).toEqual({ accepted: false, next: slot })
    const onExitOnly = feed('state=done:id=a', 1002)
    expect(onExitOnly.reportSeq).toBeGreaterThan(first.reportSeq)
    let current = accept(slot, write(onExitOnly))
    expect(current && isProgramStatusSlotHidden(current, dismissal)).toBe(true)
    current = current && accept(current, lifecycleWrite('unverifiable', 2000))
    expect(current && isProgramStatusSlotHidden(current, dismissal)).toBe(true)
    current = current && accept(current, lifecycleWrite('live', 3000))
    expect(current && isProgramStatusSlotHidden(current, dismissal)).toBe(true)
  })

  it('shows a real transition and a new incarnation again', () => {
    const { feed, write } = trackerHarness()
    const slot = accept(undefined, write(feed('state=done', 1000)))
    const dismissal = slot && ackOf(slot)
    const moved = accept(slot, write(feed('state=working', 1001)))
    expect(moved && isProgramStatusSlotHidden(moved, dismissal)).toBe(false)
    const respawned = accept(slot, {
      ...write(feed('state=done', 1002)),
      identity: NEXT_INCARNATION
    })
    expect(respawned && isProgramStatusSlotHidden(respawned, dismissal)).toBe(false)
  })
})

describe('the exit carry by PTY, with or without a pane record', () => {
  /** Dismiss the shown state, then exit; `record` false stands for a closed or evicted pane. */
  function exitAfterDismissal(dismissedBodies: string[], steps: string[], record: boolean) {
    const { feed, write } = trackerHarness()
    let state = dismissedBodies.map((body, index) => feed(body, 1000 + index)).at(-1)
    const slot = state && accept(undefined, write(state))
    let ack: ProgramStatusAck | undefined = slot && ackOf(slot)
    const dismissedSeq = state?.reportSeq ?? 0
    for (const [index, body] of steps.entries()) {
      state = feed(body, 2000 + index)
    }
    if (!state) {
      throw new Error('expected a state')
    }
    const exit = lifecycleWrite('exited', 5000, {
      shown: state.observation.onExit,
      prevNow: state.observation.now
    })
    ack = carryAckAcrossExit(ack, exit.identity, exit.prevNow, exit.shown)
    const before = !record
      ? undefined
      : state.reportSeq > dismissedSeq
        ? accept(slot, write(state))
        : slot
    const exitResult = applyProgramStatusWrite(before, exit)
    expect(exitResult.accepted).toBe(record)
    const resynced = record ? exitResult.next : accept(undefined, write(state, 'exited'))
    return resynced !== undefined && isProgramStatusSlotHidden(resynced, ack)
  }

  it.each([true, false])(
    'keeps it hidden when onExit equals the dismissed summary (record %s)',
    (record) => {
      expect(exitAfterDismissal(['state=done'], [], record)).toBe(true)
    }
  )

  it.each([true, false])('shows it when the onExit summary differs (record %s)', (record) => {
    expect(exitAfterDismissal(['state=working', 'state=done:id=a'], [], record)).toBe(false)
  })

  it.each([true, false])('shows it after a coalesced working, done (record %s)', (record) => {
    expect(exitAfterDismissal(['state=done'], ['state=working', 'state=done'], record)).toBe(false)
  })
})
