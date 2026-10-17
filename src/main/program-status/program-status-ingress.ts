// Producer-side state in main for OSC 7501: one ledger per PTY, attributed to a pane, written
// into the hook server through a sink. It never reads the store, and no reader reads it.

import { CLOSED_AGENT_STATUS_PANE_KEYS_MAX } from '../agent-hooks/server/server-constants'
import type {
  ProgramStatusFact,
  ProgramStatusIdentity,
  ProgramStatusLifecycleWrite,
  ProgramStatusLiveness,
  ProgramStatusReportWrite
} from '../../shared/program-status/program-status-slot'
import {
  applyProgramStatusFact,
  createProgramStatusLedger,
  exitProgramStatusLedger,
  loseProgramStatusLedger,
  programStatusLedgerIdentity,
  programStatusLedgerLifecycle,
  programStatusLedgerReport,
  reconnectProgramStatusLedger,
  registerProgramStatusIncarnation,
  type ProgramStatusLedger,
  type ProgramStatusLedgerStep
} from './program-status-ledger'

export type ProgramStatusIngressTarget = { paneKey: string; tabId?: string; worktreeId?: string }

/** The hook server's four producer operations; each returns whether the store accepted it. */
export type ProgramStatusSink = {
  report(target: ProgramStatusIngressTarget, write: ProgramStatusReportWrite): boolean
  lifecycle(paneKey: string, write: ProgramStatusLifecycleWrite): boolean
  rekey(
    fromPaneKey: string,
    to: ProgramStatusIngressTarget,
    identity: ProgramStatusIdentity,
    current: ProgramStatusReportWrite
  ): boolean
  forget(paneKey: string, identity: ProgramStatusIdentity, options?: { ptyRetired?: true }): boolean
}

/** Main's own proof that the renderer's `(paneKey, ptyId)` pair is bound; read-only. */
export type ProgramStatusPaneBinding = (paneKey: string, ptyId: string) => boolean

export type ProgramStatusIngressDeps = {
  sink: ProgramStatusSink
  /** The lazy rule: mounted leaves, else the PTY record's pane; `undefined` until it resolves. */
  resolveTarget(ptyId: string): ProgramStatusIngressTarget | undefined
  /** The store's alias resolution, read-only, so every comparison is between canonical keys. */
  resolvePaneKey(paneKey: string): string
  now(): number
}

export type ProgramStatusIngress = ReturnType<typeof createProgramStatusIngress>

type Attribution = {
  ledger: ProgramStatusLedger
  /** The pane last written or adopted; lifecycle writes address it. */
  target: ProgramStatusIngressTarget | null
  /** Canonical lazy key when the renderer's pane was adopted; the adoption stands until it moves. */
  adoptedOver: string | null
  /** Canonical pane the renderer rebound to another PTY; never re-entered lazily. */
  detachedFrom: string | null
  /** Liveness of the last write the store accepted, so a no-op resync publishes nothing. */
  stored: ProgramStatusLiveness | null
}

type ParkedResync = {
  paneKey: string
  ptyId: string
  bindsPane: ProgramStatusPaneBinding
  /** Lifts the pane's closure; run only once the binding proof has passed. */
  reopen?: (paneKey: string) => void
}

export function createProgramStatusIngress(deps: ProgramStatusIngressDeps) {
  const { sink } = deps
  const entries = new Map<string, Attribution>()
  const parked = new Map<string, ParkedResync>()
  const canonical = (paneKey: string): string => deps.resolvePaneKey(paneKey)

  const accept = (entry: Attribution, accepted: boolean, liveness: ProgramStatusLiveness) => {
    if (accepted) {
      entry.stored = liveness
    }
    return accepted
  }

  const moveTo = (entry: Attribution, to: ProgramStatusIngressTarget): void => {
    const identity = programStatusLedgerIdentity(entry.ledger)
    const current = programStatusLedgerReport(entry.ledger)
    // Why raw: an alias-equal key may still hold a record written before the alias existed.
    if (entry.target && identity && current && entry.target.paneKey !== to.paneKey) {
      sink.rekey(entry.target.paneKey, to, identity, current)
    }
    entry.target = to
  }

  /** The pane a write addresses, its record first moved off a key an alias has since replaced. */
  const paneOf = (entry: Attribution): ProgramStatusIngressTarget | null => {
    const key = entry.target && canonical(entry.target.paneKey)
    if (entry.target && key && key !== entry.target.paneKey) {
      moveTo(entry, { paneKey: key, worktreeId: entry.target.worktreeId })
    }
    return entry.target
  }

  const writeReport = (entry: Attribution): boolean => {
    const report = programStatusLedgerReport(entry.ledger)
    const target = report && paneOf(entry)
    return Boolean(target && accept(entry, sink.report(target, report), report.liveness))
  }

  const writeLifecycle = (entry: Attribution, write: ProgramStatusLifecycleWrite): void => {
    // Why the detached pane: the store carries the PTY's ack before the pane write, and the
    // write's identity fence then leaves the new owner's slot alone.
    const paneKey = paneOf(entry)?.paneKey ?? entry.detachedFrom
    if (paneKey) {
      accept(entry, sink.lifecycle(paneKey, write), write.liveness)
    }
  }

  const attribute = (entry: Attribution): void => {
    const lazy = deps.resolveTarget(entry.ledger.ptyId)
    const lazyKey = lazy && canonical(lazy.paneKey)
    if (!lazy || lazyKey === entry.adoptedOver || lazyKey === entry.detachedFrom) {
      return
    }
    entry.adoptedOver = null
    if (!entry.target || canonical(entry.target.paneKey) !== lazyKey) {
      moveTo(entry, lazy)
    }
  }

  const apply = (entry: Attribution, step: ProgramStatusLedgerStep): void => {
    entry.ledger = step.ledger
    if (step.report) {
      attribute(entry)
      if (step.replaced && step.report.shown === null && entry.target) {
        sink.forget(entry.target.paneKey, step.replaced)
      } else {
        writeReport(entry)
      }
    }
    if (step.lifecycle) {
      writeLifecycle(entry, step.lifecycle)
    }
  }

  const step = (
    ptyId: string,
    transition: (ledger: ProgramStatusLedger, at: number) => ProgramStatusLedgerStep
  ): void => {
    const entry = entries.get(ptyId)
    if (entry) {
      apply(entry, transition(entry.ledger, deps.now()))
    }
  }

  const detachOthers = (key: string, ptyId: string): void => {
    for (const other of entries.values()) {
      const identity = programStatusLedgerIdentity(other.ledger)
      if (other.ledger.ptyId === ptyId || !other.target) {
        continue
      }
      if (canonical(other.target.paneKey) === key) {
        // Identity-checked in the store, so a record of the bound PTY is never touched.
        if (identity) {
          sink.forget(other.target.paneKey, identity)
        }
        Object.assign(other, { target: null, adoptedOver: null, detachedFrom: key })
      }
    }
  }

  const resync = ({ paneKey, ptyId, reopen }: ParkedResync): void => {
    // Why here and not at the request: the old PTY may still target the pane, and an open
    // pane would take its next report while main binds the pane to another PTY.
    reopen?.(paneKey)
    const key = canonical(paneKey)
    detachOthers(key, ptyId)
    const entry = entries.get(ptyId)
    if (!entry || entry.ledger.incarnationId === null) {
      return
    }
    const lazy = deps.resolveTarget(ptyId)
    const to = { paneKey, ...(lazy?.worktreeId ? { worktreeId: lazy.worktreeId } : {}) }
    moveTo(entry, to)
    entry.detachedFrom = entry.detachedFrom === key ? null : entry.detachedFrom
    entry.adoptedOver = lazy ? canonical(lazy.paneKey) : null
    const lifecycle = programStatusLedgerLifecycle(entry.ledger)
    if (!writeReport(entry) && lifecycle && entry.stored !== lifecycle.liveness) {
      writeLifecycle(entry, lifecycle)
    }
  }

  const park = (key: string, request: ParkedResync): void => {
    parked.delete(key)
    parked.set(key, request)
    for (const oldest of parked.keys()) {
      if (parked.size <= CLOSED_AGENT_STATUS_PANE_KEYS_MAX) {
        break
      }
      parked.delete(oldest)
    }
  }

  const entryOf = (ptyId: string): Attribution => {
    const entry = entries.get(ptyId) ?? {
      ledger: createProgramStatusLedger(ptyId, deps.now()),
      target: null,
      adoptedOver: null,
      detachedFrom: null,
      stored: null
    }
    entries.set(ptyId, entry)
    return entry
  }

  return {
    register(ptyId: string, snapshot: ProgramStatusFact): void {
      const entry = entryOf(ptyId)
      apply(entry, registerProgramStatusIncarnation(entry.ledger, snapshot, deps.now()))
    },
    /** A daemon fact can overtake the reply that registers its PTY: it waits in the ledger. */
    fact(ptyId: string, fact: ProgramStatusFact): void {
      const entry = entryOf(ptyId)
      apply(entry, applyProgramStatusFact(entry.ledger, fact))
    },
    /** Re-runs the lazy attribution; publishes a ledger that had no pane yet. */
    settle(ptyId: string): void {
      const entry = entries.get(ptyId)
      if (entry && entry.ledger.incarnationId !== null) {
        attribute(entry)
        writeReport(entry)
      }
    },
    exited: (ptyId: string): void => step(ptyId, exitProgramStatusLedger),
    lost: (ptyId: string): void => step(ptyId, loseProgramStatusLedger),
    reconnected: (ptyId: string, snapshot: ProgramStatusFact): void =>
      step(ptyId, (ledger, at) => reconnectProgramStatusLedger(ledger, snapshot, at)),
    /** The PTY record was pruned: its slot goes, and its dismissal with it. */
    prune(ptyId: string): void {
      const entry = entries.get(ptyId)
      const identity = entry && programStatusLedgerIdentity(entry.ledger)
      const paneKey = entry?.target?.paneKey ?? entry?.detachedFrom
      entries.delete(ptyId)
      if (paneKey && identity) {
        sink.forget(paneKey, identity, { ptyRetired: true })
      }
    },
    resyncPane(
      paneKey: string,
      ptyId: string,
      bindsPane: ProgramStatusPaneBinding,
      reopen?: (paneKey: string) => void
    ): void {
      const key = canonical(paneKey)
      const request = { paneKey, ptyId, bindsPane, reopen }
      // Why park, never drop: the leaf-move and rebind resyncs land before main's maps agree.
      if (!bindsPane(paneKey, ptyId)) {
        park(key, request)
        return
      }
      parked.delete(key)
      resync(request)
    },
    retirePane(paneKey: string): void {
      parked.delete(paneKey)
      parked.delete(canonical(paneKey))
    },
    /** The deferred notification that a spawn commit or a leaf move bound this pane key. */
    paneBound(paneKey: string): void {
      for (const key of new Set([paneKey, canonical(paneKey)])) {
        const request = parked.get(key)
        if (request?.bindsPane(request.paneKey, request.ptyId)) {
          parked.delete(key)
          resync(request)
        }
      }
    }
  }
}
