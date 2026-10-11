import type { AgentStatusIpcPayload } from '../agent-status-types'
import type { ProgramStatusAck, ProgramStatusSlot } from './program-status-slot'
import { isProgramStatusSlotHidden } from './program-status-slot-transition'

/**
 * One pane's program-status slot as the host publishes it. A distinct union member with no
 * status-shaped placeholder fields, so a reader must narrow it before it can treat it as a row.
 */
export type ProgramStatusPaneIpcPayload = {
  programStatusOnly: true
  paneKey: string
  tabId?: string
  worktreeId?: string
  /** The host's transport counter: orders rows of one pane on the renderer channel. */
  revision: number
  /** `null`: forgotten, closed, evicted, or hidden by a dismissal. */
  programStatus: ProgramStatusSlot | null
}

/** The host store's record behind one pane's row. */
export type ProgramStatusPaneRecord = {
  slot: ProgramStatusSlot
  tabId?: string
  worktreeId?: string
  revision: number
}

/** The row a record publishes; a hidden record publishes no slot, so readers need no ack. */
export function programStatusPaneRow(
  paneKey: string,
  { slot, tabId, worktreeId, revision }: ProgramStatusPaneRecord,
  hidden: boolean
): ProgramStatusPaneIpcPayload {
  return {
    programStatusOnly: true,
    paneKey,
    ...(tabId !== undefined ? { tabId } : {}),
    ...(worktreeId !== undefined ? { worktreeId } : {}),
    revision,
    programStatus: hidden ? null : slot
  }
}

/** Past the bound, a resting record (`done`, `idle`) goes before any older active one. */
export function programStatusEvictionVictim(
  records: ReadonlyMap<string, ProgramStatusPaneRecord>,
  keep: string
): string | undefined {
  let oldest: string | undefined
  for (const [paneKey, { slot }] of records) {
    if (
      paneKey !== keep &&
      (slot.shown.summary.aggregate === 'done' || slot.shown.summary.aggregate === 'idle')
    ) {
      return paneKey
    }
    oldest ??= paneKey === keep ? undefined : paneKey
  }
  return oldest
}

/** Slot rows share `agentStatus:set` and the snapshot pull with hook rows; narrow them first. */
export function isProgramStatusPanePayload(value: unknown): value is ProgramStatusPaneIpcPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'programStatusOnly' in value &&
    value.programStatusOnly === true
  )
}

/** What `agentStatus:set` and the snapshot pull carry since slot rows share them. */
export type AgentStatusChannelRow = AgentStatusIpcPayload | ProgramStatusPaneIpcPayload

export function splitAgentStatusChannelRows(rows: readonly AgentStatusChannelRow[]): {
  hookRows: AgentStatusIpcPayload[]
  slotRows: ProgramStatusPaneIpcPayload[]
} {
  const hookRows: AgentStatusIpcPayload[] = []
  const slotRows: ProgramStatusPaneIpcPayload[] = []
  for (const row of rows) {
    if (isProgramStatusPanePayload(row)) {
      slotRows.push(row)
    } else {
      hookRows.push(row)
    }
  }
  return { hookRows, slotRows }
}

/** The renderer's copy of one pane's latest row; `localHide` is a dismissal not yet confirmed. */
export type ProgramStatusMirrorRecord = {
  revision: number
  tabId?: string
  worktreeId?: string
  slot: ProgramStatusSlot | null
  localHide?: ProgramStatusAck
}

export function isProgramStatusMirrorRecordVisible(
  record: ProgramStatusMirrorRecord | undefined
): record is ProgramStatusMirrorRecord & { slot: ProgramStatusSlot } {
  return !!record?.slot && !isProgramStatusSlotHidden(record.slot, record.localHide)
}
