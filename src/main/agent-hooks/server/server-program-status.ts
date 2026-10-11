import { MAX_AGENT_HOOK_STATUS_CACHE_PANES } from '../../../shared/agent-hook-status-cache'
import { ALL_EXECUTION_HOSTS_SCOPE, parseExecutionHostId } from '../../../shared/execution-host'
import type { ExecutionHostScope } from '../../../shared/execution-host'
import {
  programStatusEvictionVictim,
  programStatusPaneRow,
  type ProgramStatusPaneIpcPayload as Row,
  type ProgramStatusPaneRecord as PaneRecord
} from '../../../shared/program-status/program-status-pane-payload'
import type {
  ProgramStatusAck,
  ProgramStatusIdentity,
  ProgramStatusLifecycleWrite,
  ProgramStatusReportWrite,
  ProgramStatusSlot,
  ProgramStatusWrite
} from '../../../shared/program-status/program-status-slot'
import {
  applyProgramStatusWrite,
  carryAckAcrossExit,
  isProgramStatusSlotHidden
} from '../../../shared/program-status/program-status-slot-transition'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { worktreeIdsEqual } from '../../../shared/worktree/id'
import { CLOSED_AGENT_STATUS_PANE_KEYS_MAX } from './server-constants'
import { AgentHookServerListeners } from './server-listeners'
import { paneCacheKeyMatchesTab } from './server-status-identity'

export type ProgramStatusTarget = { paneKey: string; tabId?: string; worktreeId?: string }

const sameIdentity = (slot: ProgramStatusSlot, identity: ProgramStatusIdentity): boolean =>
  slot.ptyId === identity.ptyId && slot.incarnationId === identity.incarnationId

// Why: delete-then-add keeps the newest last, so the bound sheds only the oldest.
function trimOldest(keys: Set<string> | Map<string, unknown>): void {
  for (const oldest of keys.keys()) {
    if (keys.size <= CLOSED_AGENT_STATUS_PANE_KEYS_MAX) {
      break
    }
    keys.delete(oldest)
  }
}

/**
 * The OSC 7501 producer slot, one per canonical pane beside the hook row. It shares the store's
 * alias table and tab-closure fact, never the hook row's dismissal, retirement or teardown, and it
 * is published only on its own listener and snapshot, never as a hook row or hook event.
 */
export abstract class AgentHookServerProgramStatus extends AgentHookServerListeners {
  // Why beside the hook row and never inside it: neither producer's lifecycle may drive the other.
  protected readonly programStatusByPaneKey = new Map<string, PaneRecord>()
  protected readonly programStatusClosedPaneKeys = new Set<string>()
  // Why by PTY: a dismissal must survive a close, a resync and a pane move of its observation.
  protected readonly programStatusAckByPtyId = new Map<string, ProgramStatusAck>()
  private programStatusRevision = 0
  private programStatusListener: ((row: Row) => void) | null = null

  ingestProgramStatusReport({
    write,
    ...target
  }: ProgramStatusTarget & { write: ProgramStatusReportWrite }): boolean {
    return this.writeProgramStatus(target, write)
  }

  applyProgramStatusLifecycle(paneKey: string, write: ProgramStatusLifecycleWrite): boolean {
    const { identity, prevNow, shown } = write
    const ack = this.programStatusAckByPtyId.get(identity.ptyId)
    // Why before the closure: the ack is the PTY's, so a closed or evicted pane must not skip it.
    const carried =
      write.liveness === 'exited' ? carryAckAcrossExit(ack, identity, prevNow, shown) : ack
    if (carried && carried !== ack) {
      this.setProgramStatusAck(identity.ptyId, carried)
    }
    return this.writeProgramStatus({ paneKey }, write)
  }

  rekeyProgramStatus(
    fromPaneKey: string,
    to: ProgramStatusTarget,
    identity: ProgramStatusIdentity,
    current: ProgramStatusReportWrite
  ): boolean {
    const [fromKey, toKey] = [fromPaneKey, to.paneKey].map((key) => this.resolvePaneKeyAlias(key))
    const moved = this.programStatusByPaneKey.get(fromKey)
    if (!moved || !sameIdentity(moved.slot, identity)) {
      // Why: the source pane's closure may already have forgotten the record, as in a leaf move.
      return this.writeProgramStatus(to, current)
    }
    if (fromKey === toKey) {
      return false
    }
    this.deleteProgramStatusRecord(fromKey)
    const held = this.programStatusByPaneKey.get(toKey)?.slot
    if (
      !this.isProgramStatusPaneClosed(toKey) &&
      !(held && sameIdentity(held, identity) && held.reportSeq >= moved.slot.reportSeq)
    ) {
      const tabId = to.tabId ?? parsePaneKey(toKey)?.tabId
      this.publishProgramStatusRecord(toKey, moved.slot, tabId, to.worktreeId ?? moved.worktreeId)
    }
    return true
  }

  /** Identity-checked, so a replaced PTY's late forget cannot remove its successor's slot. */
  forgetProgramStatus(
    paneKey: string,
    identity: ProgramStatusIdentity,
    options?: { ptyRetired?: true }
  ): boolean {
    if (options?.ptyRetired) {
      this.programStatusAckByPtyId.delete(identity.ptyId)
    }
    const key = this.resolvePaneKeyAlias(paneKey)
    const record = this.programStatusByPaneKey.get(key)
    return (
      record !== undefined &&
      sameIdentity(record.slot, identity) &&
      this.deleteProgramStatusRecord(key)
    )
  }

  /**
   * Stores the ack only when it names the shown state exactly, or names the `now` view the exit
   * proved it followed (the exit's own carry rule); a stale ack changes nothing.
   */
  acknowledgeProgramStatus(paneKey: string, ack: ProgramStatusAck): boolean {
    const key = this.resolvePaneKeyAlias(paneKey)
    const record = this.programStatusByPaneKey.get(key)
    const { exitedFrom, shown } = record?.slot ?? {}
    const effective =
      record && exitedFrom ? carryAckAcrossExit(ack, record.slot, exitedFrom, shown) : ack
    if (
      !record ||
      !effective ||
      !isProgramStatusSlotHidden(record.slot, effective) ||
      this.isProgramStatusHidden(record.slot)
    ) {
      return false
    }
    this.setProgramStatusAck(record.slot.ptyId, effective)
    this.publishProgramStatusRecord(key, record.slot, record.tabId, record.worktreeId)
    return true
  }

  closeProgramStatusPane(paneKey: string): void {
    const key = this.resolvePaneKeyAlias(paneKey)
    this.deleteProgramStatusRecord(key)
    for (const closedKey of [paneKey, key]) {
      this.programStatusClosedPaneKeys.delete(closedKey)
      this.programStatusClosedPaneKeys.add(closedKey)
    }
    trimOldest(this.programStatusClosedPaneKeys)
  }

  /** Lifts the pane closure only; a closed tab stays refused through its own fact. */
  reopenProgramStatusPane(paneKey: string): void {
    this.programStatusClosedPaneKeys.delete(paneKey)
    this.programStatusClosedPaneKeys.delete(this.resolvePaneKeyAlias(paneKey))
  }

  closeProgramStatusTab(tabId: string): void {
    this.forgetProgramStatusWhere(
      (key, record) => record.tabId === tabId || paneCacheKeyMatchesTab(key, tabId)
    )
  }

  forgetProgramStatusForRemovedWorktree(worktreeId: string, host?: ExecutionHostScope): void {
    // Why: only local PTYs report into this store, so a remote host's removal owns none of it.
    if (
      host === ALL_EXECUTION_HOSTS_SCOPE ||
      parseExecutionHostId(host ?? 'local')?.kind === 'local'
    ) {
      this.forgetProgramStatusWhere(
        (_key, record) => worktreeIdsEqual(record.worktreeId ?? '', worktreeId),
        true
      )
    }
  }

  getProgramStatusSnapshot(): Row[] {
    return Array.from(this.programStatusByPaneKey, ([key, record]) =>
      this.programStatusRow(key, record)
    )
  }

  /** A separate slot from `setListener`, which drives titles and telemetry for hook events. */
  setProgramStatusListener(listener: ((row: Row) => void) | null): void {
    this.programStatusListener = listener
    for (const row of listener ? this.getProgramStatusSnapshot() : []) {
      this.emitProgramStatusRow(row)
    }
  }

  private forgetProgramStatusWhere(
    match: (key: string, record: PaneRecord) => boolean,
    close = false
  ): void {
    // Why live iteration is safe: a Map skips entries deleted before they are reached.
    for (const [key, record] of this.programStatusByPaneKey) {
      if (match(key, record) && close) {
        this.closeProgramStatusPane(key)
      } else if (match(key, record)) {
        this.deleteProgramStatusRecord(key)
      }
    }
  }

  private isProgramStatusHidden(slot: ProgramStatusSlot): boolean {
    return isProgramStatusSlotHidden(slot, this.programStatusAckByPtyId.get(slot.ptyId))
  }

  private isProgramStatusPaneClosed(paneKey: string): boolean {
    return (
      this.programStatusClosedPaneKeys.has(paneKey) ||
      this.isClosedAgentStatusTabForPaneKey(paneKey)
    )
  }

  private writeProgramStatus(target: ProgramStatusTarget, write: ProgramStatusWrite): boolean {
    const key = this.resolvePaneKeyAlias(target.paneKey)
    const prev = this.programStatusByPaneKey.get(key)
    if (this.isProgramStatusPaneClosed(key)) {
      return false
    }
    const { accepted, next } = applyProgramStatusWrite(prev?.slot, write)
    if (!accepted || !next) {
      return accepted && this.deleteProgramStatusRecord(key)
    }
    this.publishProgramStatusRecord(
      key,
      next,
      target.tabId ?? prev?.tabId,
      target.worktreeId ?? prev?.worktreeId
    )
    return true
  }

  private publishProgramStatusRecord(
    paneKey: string,
    slot: ProgramStatusSlot,
    tabId?: string,
    worktreeId?: string
  ): void {
    const record: PaneRecord = { slot, tabId, worktreeId, revision: ++this.programStatusRevision }
    // Why delete-then-set: Map order is publication order, which the eviction below reads.
    this.programStatusByPaneKey.delete(paneKey)
    this.programStatusByPaneKey.set(paneKey, record)
    this.emitProgramStatusRow(this.programStatusRow(paneKey, record))
    while (this.programStatusByPaneKey.size > MAX_AGENT_HOOK_STATUS_CACHE_PANES) {
      const victim = programStatusEvictionVictim(this.programStatusByPaneKey, paneKey)
      if (victim === undefined || !this.deleteProgramStatusRecord(victim)) {
        break
      }
    }
  }

  private deleteProgramStatusRecord(paneKey: string): boolean {
    const record = this.programStatusByPaneKey.get(paneKey)
    if (record) {
      this.programStatusByPaneKey.delete(paneKey)
      const tombstone = { ...record, revision: ++this.programStatusRevision }
      this.emitProgramStatusRow(programStatusPaneRow(paneKey, tombstone, true))
    }
    return record !== undefined
  }

  private programStatusRow(paneKey: string, record: PaneRecord): Row {
    return programStatusPaneRow(paneKey, record, this.isProgramStatusHidden(record.slot))
  }

  private setProgramStatusAck(ptyId: string, ack: ProgramStatusAck): void {
    this.programStatusAckByPtyId.delete(ptyId)
    this.programStatusAckByPtyId.set(ptyId, ack)
    trimOldest(this.programStatusAckByPtyId)
  }

  private emitProgramStatusRow(row: Row): void {
    try {
      this.programStatusListener?.(row)
    } catch (err) {
      console.error('[agent-hooks] program-status listener threw', err)
    }
  }
}
