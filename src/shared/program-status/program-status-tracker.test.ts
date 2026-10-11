import { describe, expect, it, vi } from 'vitest'
import {
  createProgramStatusTracker,
  PROGRAM_STATUS_EMIT_BURST,
  PROGRAM_STATUS_EMIT_PER_SECOND,
  PROGRAM_STATUS_TRAILING_EMIT_MS,
  type ProgramStatusTrackerEmission,
  type ProgramStatusTrackerTimers
} from './program-status-tracker'

const ESC = '\x1b'
const BEL = '\x07'
const report = (body: string): string => `${ESC}]7501;${body}${BEL}`
const PROMPT_START = `${ESC}]133;A${BEL}`
const RIS = `${ESC}c`

type ManualTimer = { callback: () => void; at: number; cleared: boolean }

/** Timers on the test's own clock: `advanceTo(t)` fires every timer due at or before `t`. */
function manualTimers() {
  const timers: ManualTimer[] = []
  let clock = 0
  const api: ProgramStatusTrackerTimers = {
    setTimeout(callback, ms) {
      const timer = { callback, at: clock + ms, cleared: false }
      timers.push(timer)
      return timer
    },
    clearTimeout(handle) {
      for (const timer of timers) {
        if (timer === handle) {
          timer.cleared = true
        }
      }
    }
  }
  return {
    api,
    now: () => clock,
    armed: () => timers.filter((timer) => !timer.cleared).length,
    advanceTo(now: number) {
      for (const timer of timers.splice(0)) {
        if (timer.cleared) {
          continue
        }
        if (timer.at <= now) {
          clock = timer.at
          timer.callback()
        } else {
          timers.push(timer)
        }
      }
      clock = now
    }
  }
}

function harness() {
  const emitted: ProgramStatusTrackerEmission[] = []
  const timers = manualTimers()
  const tracker = createProgramStatusTracker({
    emit: (emission) => emitted.push(emission),
    timers: timers.api,
    monotonicNow: timers.now
  })
  let seq = 0
  /** `now` is the wall clock the caller passes; the monotonic clock follows it unless given. */
  const feed = (data: string, now: number, monotonic = now): void => {
    timers.advanceTo(monotonic)
    tracker.observe(data, seq, now)
    seq += data.length
  }
  /** Spends the whole burst on distinct changes at `now`, so the next change is throttled. */
  const exhaustBurst = (now: number): void => {
    for (let index = 0; index < PROGRAM_STATUS_EMIT_BURST; index += 1) {
      feed(report(`state=${index % 2 === 0 ? 'working' : 'blocked'}:id=burst`), now)
    }
  }
  return { tracker, emitted, timers, feed, exhaustBurst }
}

describe('program status tracker: report sequence', () => {
  it('starts at reportSeq 0 with an empty observation', () => {
    const { tracker, emitted } = harness()
    expect(tracker.snapshot()).toEqual({ reportSeq: 0, observation: { now: null, onExit: null } })
    expect(emitted).toEqual([])
  })

  it('numbers each observation change and emits it', () => {
    const { tracker, emitted, feed } = harness()
    feed(report('state=working'), 1000)
    expect(tracker.snapshot().reportSeq).toBe(1)
    expect(tracker.snapshot().observation.now).toEqual({
      summary: { aggregate: 'working', root: 'working', childError: false },
      generation: 1,
      changedAt: 1000,
      rootChangedAt: 1000
    })
    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ reportSeq: 1, cause: 'report' })
    expect(emitted[0]?.observation).toBe(tracker.snapshot().observation)
  })

  it('takes a snapshot without incrementing, view objects included', () => {
    const { tracker, feed } = harness()
    feed(report('state=done'), 1000)
    const first = tracker.snapshot()
    const second = tracker.snapshot()
    expect(second).toEqual(first)
    expect(second.reportSeq).toBe(first.reportSeq)
    expect(second.observation.now).toBe(first.observation.now)
    expect(second.observation.onExit).toBe(first.observation.onExit)
  })

  it('gives a throttled change a number the snapshot reports, then delivers it unchanged', () => {
    const { tracker, emitted, timers, feed, exhaustBurst } = harness()
    exhaustBurst(1000)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST)
    feed(report('state=done'), 1000)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST)
    const snapshot = tracker.snapshot()
    expect(snapshot.reportSeq).toBe(PROGRAM_STATUS_EMIT_BURST + 1)
    expect(timers.armed()).toBe(1)
    timers.advanceTo(1000 + PROGRAM_STATUS_TRAILING_EMIT_MS)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST + 1)
    expect(emitted.at(-1)?.reportSeq).toBe(snapshot.reportSeq)
    expect(emitted.at(-1)?.observation).toBe(snapshot.observation)
    expect(tracker.snapshot()).toEqual(snapshot)
  })

  it('gives the descriptive double done one number and one generation', () => {
    const { tracker, emitted, feed } = harness()
    feed(report('state=done'), 1000)
    const before = tracker.snapshot()
    feed(report('state=done'), 2000)
    expect(tracker.snapshot()).toBe(before)
    expect(emitted).toHaveLength(1)
  })

  it('ignores the probe body and counts discards without a number', () => {
    const { tracker, emitted, feed } = harness()
    feed(report('?'), 1000)
    feed(report('state=nope'), 1000)
    feed(report('state=working:id=a//b'), 1000)
    expect(tracker.snapshot().reportSeq).toBe(0)
    expect(emitted).toEqual([])
    expect(tracker.discards()).toMatchObject({ state: 1, id: 1, 'frame-limit': 0 })
  })
})

describe('program status tracker: generations minted before coalescing', () => {
  it('numbers done, working, done fed in three chunks 1, 2, 3 with increasing generations', () => {
    const { tracker, feed } = harness()
    const generations: number[] = []
    for (const [index, state] of (['done', 'working', 'done'] as const).entries()) {
      feed(report(`state=${state}`), 1000 + index)
      expect(tracker.snapshot().reportSeq).toBe(index + 1)
      generations.push(tracker.snapshot().observation.now?.generation ?? 0)
    }
    expect(generations[1]).toBeGreaterThan(generations[0] ?? Infinity)
    expect(generations[2]).toBeGreaterThan(generations[1] ?? Infinity)
  })

  it('coalesces done, working, done in one chunk into one emission carrying 3 and the last generation', () => {
    const chunked = harness()
    for (const state of ['done', 'working', 'done']) {
      chunked.feed(report(`state=${state}`), 1000)
    }
    const { tracker, emitted, feed } = harness()
    feed(report('state=done') + report('state=working') + report('state=done'), 1000)
    expect(tracker.snapshot()).toEqual(chunked.tracker.snapshot())
    expect(emitted).toHaveLength(1)
    expect(emitted[0]?.reportSeq).toBe(3)
    expect(emitted[0]?.observation.now?.generation).toBe(
      chunked.tracker.snapshot().observation.now?.generation
    )
  })

  it('delivers a throttled done, working, done as one trailing emission the snapshot repeats', () => {
    const { tracker, emitted, timers, feed, exhaustBurst } = harness()
    feed(report('state=done'), 900)
    const dismissed = tracker.snapshot().observation.now
    exhaustBurst(1000)
    feed(report('state=clear:id=burst'), 1001)
    feed(report('state=working'), 1002)
    feed(report('state=done'), 1003)
    const emittedBefore = emitted.length
    timers.advanceTo(1001 + PROGRAM_STATUS_TRAILING_EMIT_MS)
    expect(emitted).toHaveLength(emittedBefore + 1)
    const last = emitted.at(-1)
    expect(last?.reportSeq).toBe(tracker.snapshot().reportSeq)
    expect(last?.observation).toEqual(tracker.snapshot().observation)
    expect(last?.observation.now?.summary).toEqual(dismissed?.summary)
    expect(last?.observation.now?.generation).toBeGreaterThan(dismissed?.generation ?? Infinity)
  })

  it('yields the same snapshot whatever the chunk boundaries', () => {
    const bytes =
      report('state=working') + report('state=working:id=a') + report('state=done:id=a') + RIS
    const whole = harness()
    whole.feed(bytes, 1000)
    for (let split = 1; split < bytes.length; split += 1) {
      const parts = harness()
      parts.feed(bytes.slice(0, split), 1000)
      parts.feed(bytes.slice(split), 1000)
      expect(parts.tracker.snapshot()).toEqual(whole.tracker.snapshot())
    }
  })

  it('changes only onExit when a child finishes under a working root', () => {
    const { tracker, feed } = harness()
    feed(report('state=working') + report('state=working:id=a'), 1000)
    const before = tracker.snapshot()
    expect(before.observation.onExit).toBeNull()
    feed(report('state=done:id=a'), 2000)
    const after = tracker.snapshot()
    expect(after.reportSeq).toBe(before.reportSeq + 1)
    expect(after.observation.now).toBe(before.observation.now)
    expect(after.observation.onExit).toEqual({
      summary: { aggregate: 'done', root: null, childError: false },
      generation: expect.any(Number),
      changedAt: 2000,
      rootChangedAt: null
    })
    expect(after.observation.onExit?.generation).toBeGreaterThan(
      before.observation.now?.generation ?? Infinity
    )
  })

  it('mints now then onExit, consecutively, when one event changes both', () => {
    const { tracker, feed } = harness()
    feed(report('state=done'), 1000)
    const { now, onExit } = tracker.snapshot().observation
    expect(now?.generation).toBe(1)
    expect(onExit?.generation).toBe(2)
  })

  it.each([
    ['clear', report('state=done'), report('state=clear'), report('state=done')],
    ['RIS', report('state=done'), RIS, report('state=done')],
    ['prompt start', report('state=working'), PROMPT_START, report('state=working')]
  ])('never reuses a generation across %s', (_name, first, middle, last) => {
    const { tracker, feed } = harness()
    const seen: (number | null)[] = []
    for (const [index, data] of [first, middle, last].entries()) {
      feed(data, 1000 + index)
      seen.push(tracker.snapshot().observation.now?.generation ?? null)
    }
    expect(seen[1]).toBeNull()
    expect(seen[0]).not.toBeNull()
    expect(seen[2]).toBeGreaterThan(seen[0] ?? Infinity)
    expect(tracker.snapshot().reportSeq).toBe(3)
  })
})

describe('program status tracker: view times on the injected clock', () => {
  it('moves changedAt only on an aggregate change and rootChangedAt only on a root change', () => {
    const { tracker, feed } = harness()
    feed(report('state=working'), 1000)
    feed(report('state=blocked:id=a'), 2000)
    expect(tracker.snapshot().observation.now).toMatchObject({
      changedAt: 2000,
      rootChangedAt: 1000
    })
    feed(report('state=done'), 3000)
    expect(tracker.snapshot().observation.now).toMatchObject({
      summary: { aggregate: 'blocked', root: 'done', childError: false },
      changedAt: 2000,
      rootChangedAt: 3000
    })
    feed(report('state=error:id=a'), 4000)
    expect(tracker.snapshot().observation.now).toMatchObject({
      summary: { aggregate: 'done', root: 'done', childError: true },
      changedAt: 4000,
      rootChangedAt: 3000
    })
  })

  it('carries the time of the last real change on a coalesced emission, not the emission time', () => {
    const { emitted, timers, feed, exhaustBurst } = harness()
    exhaustBurst(1000)
    feed(report('state=clear:id=burst') + report('state=done'), 1040)
    timers.advanceTo(5000)
    expect(emitted.at(-1)?.observation.now).toMatchObject({ changedAt: 1040, rootChangedAt: 1040 })
  })
})

describe('program status tracker: emission budget', () => {
  it('emits a burst at once and holds the rest for one trailing timer', () => {
    const { emitted, timers, feed, exhaustBurst } = harness()
    exhaustBurst(1000)
    feed(report('state=done'), 1000)
    feed(report('state=working'), 1000)
    expect(timers.armed()).toBe(1)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST)
  })

  it('stays within burst plus rate over a one second flood and ends on the exact final state', () => {
    const { tracker, emitted, timers, feed } = harness()
    for (let step = 0; step < 10_000; step += 1) {
      feed(report(`state=${step % 2 === 0 ? 'working' : 'done'}`), step / 10)
    }
    timers.advanceTo(2000)
    const budget = PROGRAM_STATUS_EMIT_BURST + PROGRAM_STATUS_EMIT_PER_SECOND * 1.1
    expect(emitted.length).toBeLessThanOrEqual(budget)
    expect(emitted.length).toBeGreaterThan(PROGRAM_STATUS_EMIT_PER_SECOND)
    expect(emitted.at(-1)?.reportSeq).toBe(10_000)
    expect(emitted.at(-1)?.observation).toBe(tracker.snapshot().observation)
    const seqs = emitted.map((emission) => emission.reportSeq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('emits a change at once again after the bucket refills', () => {
    const { tracker, emitted, feed, exhaustBurst, timers } = harness()
    exhaustBurst(1000)
    timers.advanceTo(2000)
    feed(report('state=done'), 2000)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST + 1)
    expect(emitted.at(-1)?.reportSeq).toBe(tracker.snapshot().reportSeq)
    expect(timers.armed()).toBe(0)
  })
})

describe('program status tracker: emission budget across a backward clock step', () => {
  it('delivers the final state on the trailing timer after the clock steps back', () => {
    const { tracker, emitted, timers, feed, exhaustBurst } = harness()
    exhaustBurst(10_000)
    feed(report('state=done'), 0)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST)
    timers.advanceTo(PROGRAM_STATUS_TRAILING_EMIT_MS)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST + 1)
    expect(emitted.at(-1)?.reportSeq).toBe(tracker.snapshot().reportSeq)
    expect(timers.armed()).toBe(0)
  })

  it('refills from the new clock reading rather than waiting for the old one', () => {
    const { tracker, emitted, timers, feed, exhaustBurst } = harness()
    exhaustBurst(10_000)
    feed(report('state=done'), 0)
    timers.advanceTo(PROGRAM_STATUS_TRAILING_EMIT_MS)
    feed(report('state=working'), 1000)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST + 2)
    expect(emitted.at(-1)?.reportSeq).toBe(tracker.snapshot().reportSeq)
    expect(timers.armed()).toBe(0)
  })

  it('keeps the rate bound when the wall clock steps back with the trailing timer armed', () => {
    const { tracker, emitted, timers, feed, exhaustBurst } = harness()
    const start = 10_000
    const step = PROGRAM_STATUS_TRAILING_EMIT_MS
    const bound = (ms: number): number =>
      PROGRAM_STATUS_EMIT_BURST + (PROGRAM_STATUS_EMIT_PER_SECOND * ms) / 1000
    exhaustBurst(start)
    feed(report('state=done'), start)
    expect(timers.armed()).toBe(1)
    feed(report('state=working'), 0, start)
    timers.advanceTo(start + step)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST + 1)
    for (let index = 0; index < 7; index += 1) {
      feed(report(`state=${index % 2 === 0 ? 'blocked' : 'working'}`), step, start + step)
    }
    expect(emitted.length).toBeLessThanOrEqual(bound(step))
    expect(emitted.at(-1)?.reportSeq).toBeLessThan(tracker.snapshot().reportSeq)
    timers.advanceTo(start + 2 * step)
    expect(emitted.at(-1)?.reportSeq).toBe(tracker.snapshot().reportSeq)
    expect(emitted.length).toBeLessThanOrEqual(bound(2 * step))
    expect(timers.armed()).toBe(0)
  })

  it('reads a monotonic clock by default, not the wall clock the caller passes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(10_000)
    const emitted: ProgramStatusTrackerEmission[] = []
    const tracker = createProgramStatusTracker({ emit: (emission) => emitted.push(emission) })
    let seq = 0
    const feed = (body: string): void => {
      const data = report(body)
      tracker.observe(data, seq, Date.now())
      seq += data.length
    }
    try {
      for (let index = 0; index < PROGRAM_STATUS_EMIT_BURST; index += 1) {
        feed(`state=${index % 2 === 0 ? 'working' : 'blocked'}`)
      }
      feed('state=done')
      expect(vi.getTimerCount()).toBe(1)
      vi.setSystemTime(0)
      feed('state=working')
      vi.advanceTimersByTime(PROGRAM_STATUS_TRAILING_EMIT_MS)
      expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST + 1)
      for (let index = 0; index < 7; index += 1) {
        feed(`state=${index % 2 === 0 ? 'blocked' : 'working'}`)
      }
      expect(emitted.length).toBeLessThanOrEqual(
        PROGRAM_STATUS_EMIT_BURST + PROGRAM_STATUS_EMIT_PER_SECOND * 0.1
      )
      vi.advanceTimersByTime(PROGRAM_STATUS_TRAILING_EMIT_MS)
      expect(emitted.at(-1)?.reportSeq).toBe(tracker.snapshot().reportSeq)
    } finally {
      tracker.dispose()
      vi.useRealTimers()
    }
  })
})

describe('program status tracker: dispose', () => {
  it('clears the trailing timer and ignores later calls', () => {
    const { tracker, emitted, timers, feed, exhaustBurst } = harness()
    exhaustBurst(1000)
    feed(report('state=done'), 1000)
    const before = tracker.snapshot()
    tracker.dispose()
    expect(timers.armed()).toBe(0)
    feed(report('state=error'), 1001)
    timers.advanceTo(5000)
    expect(tracker.snapshot()).toBe(before)
    expect(emitted).toHaveLength(PROGRAM_STATUS_EMIT_BURST)
  })
})
