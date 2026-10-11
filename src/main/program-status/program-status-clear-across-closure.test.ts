// A deferred dismissal (Clear completed with its undo window) across a closed pane and an exit,
// through the real tracker, ingress and host store: only the producer's proof of the `now` view
// the exit followed may carry it, on the client and on the host alike.
import { describe, expect, it } from 'vitest'
import type { ProgramStatusPaneIpcPayload } from '../../shared/program-status/program-status-pane-payload'
import {
  advancePendingHides,
  derivedLocalHide,
  type ProgramStatusPendingHides
} from '../../shared/program-status/program-status-pending-hide'
import { makePaneKey } from '../../shared/stable-pane-id'
import { AgentHookServer } from '../agent-hooks/server'
import { LEAF_1 } from '../agent-hooks/server.test-fixtures'
import { createProgramStatusIngress } from './program-status-ingress'
import { createProgramStatusLocalIngest } from './program-status-local-ingest'

const PANE = makePaneKey('tab-1', LEAF_1)
const NOW = 1_800_000_000_000
const report = (state: string): string => `\x1b]7501;state=${state}\x07`

function wired() {
  const server = new AgentHookServer()
  const rows: ProgramStatusPaneIpcPayload[] = []
  server.setProgramStatusListener((row) => rows.push(row))
  const ingress = createProgramStatusIngress({
    sink: {
      report: (target, write) => server.ingestProgramStatusReport({ ...target, write }),
      lifecycle: (paneKey, write) => server.applyProgramStatusLifecycle(paneKey, write),
      rekey: (from, to, identity, current) =>
        server.rekeyProgramStatus(from, to, identity, current),
      forget: (paneKey, identity, options) => server.forgetProgramStatus(paneKey, identity, options)
    },
    resolveTarget: () => ({ paneKey: PANE, tabId: 'tab-1', worktreeId: 'wt-1' }),
    resolvePaneKey: (paneKey) => server.resolveProgramStatusPaneKey(paneKey),
    now: () => NOW
  })
  const local = createProgramStatusLocalIngest(ingress)
  const hostSlot = () =>
    server.getProgramStatusSnapshot().find((row) => row.paneKey === PANE)?.programStatus

  /**
   * The client's side of Clear completed: one operation on the finished slot, advanced by every
   * row the host publishes while the pane closes, the PTY exits and the pane comes back.
   */
  function clearCloseExitRestore(behind: () => void) {
    local.begin('pty-1', 'inc-1')
    local.observe('pty-1', report('done'), NOW)
    const cleared = rows.at(-1)!
    const slot = cleared.programStatus!
    const ack = {
      incarnationId: slot.incarnationId,
      view: slot.view,
      generation: slot.shown.generation
    }
    let hides: ProgramStatusPendingHides = {
      cleared: { ptyId: slot.ptyId, ack, shown: slot.shown, revision: cleared.revision }
    }
    server.closeProgramStatusPane(PANE)
    const publishedBeforeClose = rows.length
    behind()
    local.exit('pty-1', true)
    expect(rows).toHaveLength(publishedBeforeClose)
    server.reopenProgramStatusPane(PANE)
    ingress.resyncPane(PANE, 'pty-1', () => true)
    for (const row of rows.slice(publishedBeforeClose)) {
      hides = advancePendingHides(hides, row.programStatus, row.revision)
    }
    const restored = hostSlot()
    expect(restored).toMatchObject({ view: 'onExit', liveness: 'exited' })
    return { ack, restored: restored!, hides }
  }
  return { server, local, hostSlot, clearCloseExitRestore }
}

describe('a cleared result across a closed pane and an exit', () => {
  it('the exit of that same result stays hidden, and the host carries the ack it hid', () => {
    const h = wired()
    const { ack, restored, hides } = h.clearCloseExitRestore(() => {})
    expect(restored.exitedFrom?.generation).toBe(ack.generation)
    expect(derivedLocalHide(hides, restored)).toMatchObject({ view: 'onExit' })
    expect(h.server.acknowledgeProgramStatus(PANE, ack)).toBe(true)
    expect(h.hostSlot()).toBeNull()
  })

  it('a newer result produced behind the closure shows, and the stale ack is refused', () => {
    const h = wired()
    const { ack, restored, hides } = h.clearCloseExitRestore(() => {
      h.local.observe('pty-1', report('working'), NOW + 1)
      h.local.observe('pty-1', report('done'), NOW + 2)
    })
    expect(restored.exitedFrom?.generation).toBeGreaterThan(ack.generation)
    expect(derivedLocalHide(hides, restored)).toBeUndefined()
    expect(hides).toEqual({})
    expect(h.server.acknowledgeProgramStatus(PANE, ack)).toBe(false)
    expect(h.hostSlot()).toMatchObject({ view: 'onExit' })
  })
})
