/**
 * The OSC 7501 reports of the agent CLI `claude-code` 2.1.295, replayed byte for byte from captured
 * transcripts (`__fixtures__/claude-program-status-2-1-295-*.txt`, each `.meta.json` names the route).
 *
 * The agent reports only after its `ESC ] 7501 ; ?` probe is answered ahead of DA1, so every
 * transcript opens with the probe and then carries the reports the pure core must read: the
 * scanner wherever a PTY read splits them, the parser on every one, and the tracker into the
 * transitions a status dot shows.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseProgramStatusReport } from '../../shared/program-status/program-status-report'
import { createProgramStatusRecordStore } from '../../shared/program-status/program-status-record-store'
import {
  createProgramStatusStreamScanner,
  type ProgramStatusScanEvent
} from '../../shared/program-status/program-status-stream-scanner'
import {
  createProgramStatusTracker,
  type ProgramStatusTrackerEmission
} from '../../shared/program-status/program-status-tracker'

const SCENARIOS = ['startup', 'turn', 'permission', 'question', 'interrupt', 'subagent'] as const
type Scenario = (typeof SCENARIOS)[number]
const REPORT_PREFIX = '\x1b]7501;'

function readTranscript(scenario: Scenario): string {
  const base = join(__dirname, '__fixtures__', `claude-program-status-2-1-295-${scenario}`)
  return readFileSync(`${base}.txt`, 'utf8')
}

/** Every split in `bounds` cuts the transcript there; one scanner per delivery, as per PTY. */
function scanEvents(text: string, bounds: readonly number[]): ProgramStatusScanEvent[] {
  const scanner = createProgramStatusStreamScanner()
  const events: ProgramStatusScanEvent[] = []
  const sink = {
    isResetArmed: () => true,
    isPromptStartArmed: () => true,
    onEvent: (event: ProgramStatusScanEvent) => events.push(event)
  }
  let start = 0
  for (const end of [...bounds, text.length]) {
    if (end > start) {
      scanner.scan(text.slice(start, end), start, sink)
      start = end
    }
  }
  return events
}

function everyRead(length: number, size: number): number[] {
  const bounds: number[] = []
  for (let offset = size; offset < length; offset += size) {
    bounds.push(offset)
  }
  return bounds
}

/** Each `ESC ] 7501 ;` body up to its BEL or ESC, as the agent writes them (no torn frame). */
function reportBodies(text: string): string[] {
  const bodies: string[] = []
  let at = text.indexOf(REPORT_PREFIX)
  while (at !== -1) {
    const from = at + REPORT_PREFIX.length
    let end = from
    while (end < text.length && text[end] !== '\x07' && text[end] !== '\x1b') {
      end += 1
    }
    bodies.push(text.slice(from, end))
    at = text.indexOf(REPORT_PREFIX, end)
  }
  return bodies
}

type Step = { aggregate: string | null; root: string | null; onExit: string | null }

/** Reads at a fixed size a second apart, so the emission budget never coalesces two changes. */
function trackTranscript(text: string): {
  steps: Step[]
  emissions: ProgramStatusTrackerEmission[]
  discards: number
} {
  let clock = 0
  const emissions: ProgramStatusTrackerEmission[] = []
  const tracker = createProgramStatusTracker({
    emit: (emission) => emissions.push(emission),
    monotonicNow: () => clock
  })
  let start = 0
  for (const end of [...everyRead(text.length, 64), text.length]) {
    clock += 1000
    tracker.observe(text.slice(start, end), start, 1_700_000_000_000 + clock)
    start = end
  }
  tracker.dispose()
  const steps = emissions.map(({ observation }) => ({
    aggregate: observation.now?.summary.aggregate ?? null,
    root: observation.now?.summary.root ?? null,
    onExit: observation.onExit?.summary.aggregate ?? null
  }))
  const discards = Object.values(tracker.discards()).reduce((sum, count) => sum + count, 0)
  return { steps, emissions, discards }
}

describe('claude-code 2.1.295 OSC 7501 transcripts', () => {
  it.each(SCENARIOS)('%s: opens with the probe the reply was written for', (scenario) => {
    const text = readTranscript(scenario)
    const probe = text.indexOf('\x1b]7501;?')
    expect(probe).toBeGreaterThanOrEqual(0)
    // The probe precedes every report: the agent reports only once it was answered.
    expect(text.indexOf('\x1b]7501;state=')).toBeGreaterThan(probe)
  })

  it.each(SCENARIOS)(
    '%s: the scanner yields the same events wherever a read splits',
    (scenario) => {
      const text = readTranscript(scenario)
      const whole = scanEvents(text, [])
      expect(whole.filter((event) => event.kind === 'report')).toHaveLength(
        reportBodies(text).filter((body) => body !== '?').length
      )
      for (const size of [1, 2, 3, 7, 64, 1024, 4096]) {
        expect(scanEvents(text, everyRead(text.length, size))).toEqual(whole)
      }
      // Two reads cut at every offset in and around each sequence the scanner reports.
      for (const event of whole) {
        for (let cut = Math.max(1, event.start - 1); cut <= event.end + 1; cut += 1) {
          expect(scanEvents(text, [cut])).toEqual(whole)
        }
      }
    }
  )

  it.each(SCENARIOS)('%s: the parser accepts every report', (scenario) => {
    const bodies = reportBodies(readTranscript(scenario)).filter((body) => body !== '?')
    expect(bodies.length).toBeGreaterThan(0)
    for (const body of bodies) {
      const result = parseProgramStatusReport(body)
      expect(result, body).toMatchObject({ kind: 'report', skippedPairs: 0 })
      if (result.kind === 'report' && result.report.state !== 'clear') {
        expect(result.report.app).toBe('claude-code')
      }
    }
  })

  const transitions: Record<Scenario, Step[]> = {
    startup: [{ aggregate: 'idle', root: 'idle', onExit: null }],
    turn: [
      { aggregate: 'idle', root: 'idle', onExit: null },
      { aggregate: 'working', root: 'working', onExit: null },
      { aggregate: 'done', root: 'done', onExit: 'done' }
    ],
    permission: [
      { aggregate: 'idle', root: 'idle', onExit: null },
      { aggregate: 'working', root: 'working', onExit: null },
      { aggregate: 'blocked', root: 'blocked', onExit: null },
      { aggregate: 'working', root: 'working', onExit: null },
      { aggregate: 'done', root: 'done', onExit: 'done' }
    ],
    question: [
      { aggregate: 'idle', root: 'idle', onExit: null },
      { aggregate: 'working', root: 'working', onExit: null },
      { aggregate: 'question', root: 'question', onExit: null },
      { aggregate: 'working', root: 'working', onExit: null },
      { aggregate: 'done', root: 'done', onExit: 'done' }
    ],
    interrupt: [
      { aggregate: 'idle', root: 'idle', onExit: null },
      { aggregate: 'working', root: 'working', onExit: null },
      { aggregate: 'idle', root: 'idle', onExit: null }
    ],
    subagent: [
      { aggregate: 'idle', root: 'idle', onExit: null },
      { aggregate: 'working', root: 'working', onExit: null },
      { aggregate: 'done', root: 'done', onExit: 'done' },
      { aggregate: null, root: null, onExit: null }
    ]
  }

  it.each(SCENARIOS)('%s: the tracker yields the real transitions', (scenario) => {
    const text = readTranscript(scenario)
    const { steps, emissions, discards } = trackTranscript(text)
    expect(discards).toBe(0)
    expect(steps).toEqual(transitions[scenario])
    expect(emissions.map((emission) => emission.reportSeq)).toEqual(
      steps.map((_, index) => index + 1)
    )
  })

  it('folds the descriptive second `done` into the first', () => {
    for (const scenario of ['permission', 'question', 'subagent'] as const) {
      const bodies = reportBodies(readTranscript(scenario))
      const dones = bodies.filter((body) => body.startsWith('state=done'))
      // The agent reports `done`, then `done` again with the turn's summary as `msg`.
      expect(dones).toHaveLength(2)
      expect(dones[1]).toMatch(/:msg=/)
      const doneSteps = trackTranscript(readTranscript(scenario)).steps.filter(
        (step) => step.aggregate === 'done'
      )
      expect(doneSteps).toHaveLength(1)
    }
  })

  it('subagent: a child record under a working root, cleared by id, then the exit-time root clears', () => {
    const bodies = reportBodies(readTranscript('subagent')).filter((body) => body !== '?')
    const store = createProgramStatusRecordStore()
    const counts: number[] = []
    let child: string | null = null
    for (const body of bodies) {
      const result = parseProgramStatusReport(body)
      if (result.kind !== 'report') {
        throw new Error(`discarded: ${body}`)
      }
      if (result.report.id !== null && result.report.state !== 'clear') {
        child = result.report.id
        // The child is announced while the root is working, and does not change the aggregate.
        expect(store.project().now?.aggregate).toBe('working')
      }
      store.applyReport(result.report)
      counts.push(store.recordCount())
    }
    expect(child).not.toBeNull()
    expect(bodies).toContain(`state=clear:id=${child}`)
    expect(Math.max(...counts)).toBe(2)
    // The agent clears the root three times on its way out; the first already empties the store.
    expect(bodies.slice(-3)).toEqual(['state=clear', 'state=clear', 'state=clear'])
    expect(counts.slice(-3)).toEqual([0, 0, 0])
    expect(store.project()).toEqual({ now: null, onExit: null })
  })
})
