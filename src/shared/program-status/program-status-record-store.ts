import {
  summarizeProgramStatusRecords,
  type ProgramStatusProjection,
  type ProgramStatusRecord,
  type ProgramStatusSummary
} from './program-status-projection'
import type { ProgramStatusReport } from './program-status-report'

/** The protocol requires at least 64; past this, the least recently updated record goes. */
export const PROGRAM_STATUS_MAX_RECORDS = 256

export type ProgramStatusRecordStore = {
  /** A report replaces its record completely; `clear` removes the record and its subtree. */
  applyReport(report: ProgramStatusReport): void
  /** OSC 133;A: drops `working` and `blocked`, keeps `idle`, `done` and `error`. */
  applyPromptStart(): void
  /** RIS: drops every record. */
  applyReset(): void
  hasRecords(): boolean
  /** Some record is `working` or `blocked`. */
  hasActiveRecords(): boolean
  recordCount(): number
  project(): ProgramStatusProjection
  /** The summary once the attached process exits, without changing the store. */
  projectAfterProcessExit(): ProgramStatusSummary | null
}

const ROOT_KEY = ''

function isActive(record: ProgramStatusRecord): boolean {
  return record.state === 'working' || record.state === 'blocked'
}

function survivesProcessExit(record: ProgramStatusRecord): boolean {
  return record.state === 'done' || record.state === 'error'
}

function* filterRecords(
  records: Iterable<ProgramStatusRecord>,
  keep: (record: ProgramStatusRecord) => boolean
): Generator<ProgramStatusRecord> {
  for (const record of records) {
    if (keep(record)) {
      yield record
    }
  }
}

class RecordStore implements ProgramStatusRecordStore {
  // Why a Map: insertion order is update order, because an update deletes then re-inserts.
  private readonly records = new Map<string, ProgramStatusRecord>()
  private activeCount = 0

  applyReport(report: ProgramStatusReport): void {
    if (report.state === 'clear') {
      this.clearSubtree(report.id)
      return
    }
    const key = report.id ?? ROOT_KEY
    this.remove(key)
    const record: ProgramStatusRecord = { id: report.id, state: report.state, kind: report.kind }
    this.records.set(key, record)
    this.activeCount += isActive(record) ? 1 : 0
    if (this.records.size > PROGRAM_STATUS_MAX_RECORDS) {
      const oldest = this.records.keys().next()
      if (!oldest.done) {
        this.remove(oldest.value)
      }
    }
  }

  applyPromptStart(): void {
    for (const [key, record] of this.records) {
      if (isActive(record)) {
        this.remove(key)
      }
    }
  }

  applyReset(): void {
    this.records.clear()
    this.activeCount = 0
  }

  hasRecords(): boolean {
    return this.records.size > 0
  }

  hasActiveRecords(): boolean {
    return this.activeCount > 0
  }

  recordCount(): number {
    return this.records.size
  }

  project(): ProgramStatusProjection {
    return {
      now: summarizeProgramStatusRecords(this.records.values()),
      onExit: this.projectAfterProcessExit()
    }
  }

  projectAfterProcessExit(): ProgramStatusSummary | null {
    return summarizeProgramStatusRecords(filterRecords(this.records.values(), survivesProcessExit))
  }

  private clearSubtree(id: string | null): void {
    if (id === null) {
      this.applyReset()
      return
    }
    const descendantPrefix = `${id}/`
    for (const key of this.records.keys()) {
      if (key === id || key.startsWith(descendantPrefix)) {
        this.remove(key)
      }
    }
  }

  private remove(key: string): void {
    const record = this.records.get(key)
    if (record !== undefined) {
      this.records.delete(key)
      this.activeCount -= isActive(record) ? 1 : 0
    }
  }
}

/** Per-terminal OSC 7501 records, the store the protocol describes. */
export function createProgramStatusRecordStore(): ProgramStatusRecordStore {
  return new RecordStore()
}
