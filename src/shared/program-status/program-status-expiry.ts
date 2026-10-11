import {
  AGENT_STATUS_STALE_AFTER_MS,
  agentStatusEvidenceObservedAt,
  type AgentStatusEntry
} from '../agent-status-types'
import {
  programStatusEntryFromSlot,
  type ProgramStatusComposedEntry
} from './compose-agent-status-entry'
import {
  isProgramStatusMirrorRecordVisible,
  type ProgramStatusMirrorRecord
} from './program-status-pane-payload'
import type { ProgramStatusSlot } from './program-status-slot'

// Why per record object: a hook ping elsewhere must not mint a new entry for a slot pane.
const entryByRecord = new WeakMap<ProgramStatusMirrorRecord, ProgramStatusComposedEntry>()

/** The display entry of one visible mirror record, one object per record object. */
export function programStatusMirrorEntry(
  paneKey: string,
  record: ProgramStatusMirrorRecord & { slot: ProgramStatusSlot }
): ProgramStatusComposedEntry {
  let entry = entryByRecord.get(record)
  if (!entry) {
    const { tabId, worktreeId, slot } = record
    entry = programStatusEntryFromSlot({ paneKey, tabId, worktreeId, slot })
    entryByRecord.set(record, entry)
  }
  return entry
}

/** When a composed slot entry stops being fresh; `null` while live, since no heartbeat is owed. */
export function composedEntryStaleAt(
  entry: Pick<
    AgentStatusEntry,
    'updatedAt' | 'evidenceObservedAt' | 'mirroredEvidenceReceivedAt'
  > & {
    programStatusLive?: true
  }
): number | null {
  return entry.programStatusLive === true
    ? null
    : agentStatusEvidenceObservedAt(entry) + AGENT_STATUS_STALE_AFTER_MS
}

const NO_EXPIRING_ENTRIES: Record<string, AgentStatusEntry> = {}
let expiringMemo: {
  records: Record<string, ProgramStatusMirrorRecord> | undefined
  entries: Record<string, AgentStatusEntry>
} | null = null

/**
 * The slot scheduler's candidates: every visible non-live slot, whoever wins its pane, so the
 * set is a function of the mirror alone and a preference flip or a hook end finds it armed.
 */
export function selectExpiringProgramStatusEntries(
  records: Record<string, ProgramStatusMirrorRecord> | undefined
): Record<string, AgentStatusEntry> {
  if (expiringMemo && expiringMemo.records === records) {
    return expiringMemo.entries
  }
  let entries = NO_EXPIRING_ENTRIES
  for (const [paneKey, record] of Object.entries(records ?? {})) {
    if (isProgramStatusMirrorRecordVisible(record) && record.slot.liveness !== 'live') {
      entries = entries === NO_EXPIRING_ENTRIES ? {} : entries
      entries[paneKey] = programStatusMirrorEntry(paneKey, record)
    }
  }
  expiringMemo = { records, entries }
  return entries
}
