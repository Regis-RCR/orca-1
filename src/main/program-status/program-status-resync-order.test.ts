import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../shared/agent-status-types'
import { programStatusEntryFromSlot } from '../../shared/program-status/compose-agent-status-entry'
import { composedEntryStaleAt } from '../../shared/program-status/program-status-expiry'
import type { ProgramStatusPaneIpcPayload } from '../../shared/program-status/program-status-pane-payload'
import type {
  ProgramStatusSummaryState,
  ProgramStatusView
} from '../../shared/program-status/program-status-slot'
import { makePaneKey } from '../../shared/stable-pane-id'
import { agentHookServer } from '../agent-hooks/server'
import { registerAgentHookHandlers } from '../ipc/agent-hooks'
import { commitLeafMoveAndRekey } from '../ipc/pty/ipc/leaf-move'
import {
  getPaneKeyForPty,
  getPtyIdForPaneKey,
  paneKeyPtyId,
  ptyPaneKey,
  rememberPaneKeyForPty
} from '../ipc/pty/pane/key-state'
import { clearProviderPtyState } from '../ipc/pty/provider/state-cleanup'
import type { Store } from '../persistence'
import { driveSyntheticTitleFromHook } from '../startup/synthetic-title-runtime'
import { mainProcessState } from '../startup/main-process-state'
import {
  createProgramStatusIngress,
  type ProgramStatusIngressTarget
} from './program-status-ingress'
import {
  installedProgramStatusIngress,
  installProgramStatusIngress
} from './program-status-local-ingest'

// Real IPC handlers, the real hook server and main's real pane/PTY maps; only electron's
// ipcMain is captured, and the runtime's lazy attribution is a map the test drives.
const onHandlers = new Map<string, (event: unknown, ...args: unknown[]) => void>()
const handleHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      handleHandlers.set(channel, handler),
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) =>
      onHandlers.set(channel, handler),
    removeHandler: () => {},
    removeAllListeners: () => {}
  }
}))

const LEAF = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF = '22222222-2222-4222-8222-222222222222'
const MINUTE = 60_000
const report = (body: string): string => `\x1b]7501;${body}\x07`
let suite = 0

function view(aggregate: ProgramStatusSummaryState, generation: number): ProgramStatusView {
  const summary = { aggregate, root: aggregate, childError: false }
  return { summary, generation, changedAt: 1, rootChangedAt: 1 }
}

function harness() {
  suite += 1
  const pane = (tab: string, leaf = LEAF) => makePaneKey(`t${suite}-${tab}`, leaf)
  const targets = new Map<string, ProgramStatusIngressTarget>()
  let clock = 1_000
  const ingress = createProgramStatusIngress({
    sink: {
      report: (target, write) => agentHookServer.ingestProgramStatusReport({ ...target, write }),
      lifecycle: (paneKey, write) => agentHookServer.applyProgramStatusLifecycle(paneKey, write),
      rekey: (from, to, identity, current) =>
        agentHookServer.rekeyProgramStatus(from, to, identity, current),
      forget: (paneKey, identity, options) =>
        agentHookServer.forgetProgramStatus(paneKey, identity, options)
    },
    resolveTarget: (ptyId) => targets.get(ptyId),
    resolvePaneKey: (paneKey) => agentHookServer.resolveProgramStatusPaneKey(paneKey),
    now: () => clock
  })
  installProgramStatusIngress(ingress)
  const local = installedProgramStatusIngress()!.local
  const rows: ProgramStatusPaneIpcPayload[] = []
  agentHookServer.setProgramStatusListener((row) => rows.push(row))
  const ipc = (channel: string, ...args: unknown[]) => onHandlers.get(channel)!({}, ...args)
  const slotAt = (paneKey: string) =>
    agentHookServer.getProgramStatusSnapshot().find((row) => row.paneKey === paneKey)
  const h = {
    ingress,
    local,
    rows,
    targets,
    pane,
    slotAt,
    visibleAt: (paneKey: string) => slotAt(paneKey)?.programStatus ?? undefined,
    hiddenAt: (paneKey: string) => slotAt(paneKey)?.programStatus === null,
    setClock: (at: number) => (clock = at),
    // Why per suite: the hook server is the real singleton, and its acks are keyed by PTY.
    inc: (ptyId: string) => `inc-${suite}-${ptyId}`,
    /** A spawn commit: main's maps, then the runtime's record pane, then a tracker. */
    spawn(ptyId: string, paneKey: string, state?: string) {
      rememberPaneKeyForPty(ptyId, paneKey)
      targets.set(ptyId, { paneKey, worktreeId: 'wt-1' })
      local.begin(ptyId, `inc-${suite}-${ptyId}`)
      if (state) {
        local.observe(ptyId, report(`state=${state}`), 2_000)
      }
    },
    restore: (paneKey: string, ptyId: unknown) =>
      ipc('agentStatus:restorePaneAuthority', paneKey, ptyId),
    retire: (paneKey: string) => ipc('agentStatus:retirePaneAuthority', paneKey),
    dismiss(paneKey: string) {
      const slot = slotAt(paneKey)!.programStatus!
      const { incarnationId, view: shownView, shown } = slot
      ipc('agentStatus:drop', paneKey, {
        incarnationId,
        view: shownView,
        generation: shown.generation
      })
    },
    published: () => rows.splice(0).map((row) => [row.paneKey, row.programStatus?.ptyId ?? null]),
    async leafMove(fromTab: string, toTab: string, ptyId: string) {
      const request = {
        worktreeId: 'wt-1',
        sourceTabId: `t${suite}-${fromTab}`,
        targetTabId: `t${suite}-${toTab}`,
        leafId: LEAF,
        ptyId
      }
      const store = { moveTerminalLeafToNewTab: async () => ({ status: 'moved', ptyId }) }
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the move reads only this Store method.
      await commitLeafMoveAndRekey({ store: store as unknown as Store }, request)
    }
  }
  return h
}

const flushMicrotasks = () => new Promise<void>((resolve) => queueMicrotask(resolve))

beforeEach(() => {
  registerAgentHookHandlers(undefined, { getPtyIdForPaneKey, getPaneKeyForPty })
})

afterEach(() => {
  installProgramStatusIngress(null)
  agentHookServer.setProgramStatusListener(null)
  ptyPaneKey.clear()
  paneKeyPtyId.clear()
  vi.restoreAllMocks()
})

describe('resync after a reopen: every order', () => {
  it('1: retire then restore of the same PTY republishes the last fact once', () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.retire(P)
    h.published()
    h.restore(P, 'x')
    expect(h.visibleAt(P)).toMatchObject({ ptyId: 'x', reportSeq: 1, liveness: 'live' })
    expect(h.published()).toEqual([[P, 'x']])
  })

  it.each([
    ['greater', 2],
    ['equal', 1]
  ])('2: a %s snapshot before the reopen is visible after the restore', (_name, seq) => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.retire(P)
    h.ingress.lost('x')
    h.ingress.reconnected('x', {
      incarnationId: h.inc('x'),
      reportSeq: seq,
      observation: { now: view('done', 9), onExit: null }
    })
    h.restore(P, 'x')
    expect(h.visibleAt(P)).toMatchObject({ reportSeq: seq, liveness: 'live' })
  })

  it('3: after the reopen, a greater snapshot applies and an equal one publishes nothing', () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.retire(P)
    h.restore(P, 'x')
    expect(h.visibleAt(P)?.reportSeq).toBe(1)
    h.published()
    const snapshot = {
      incarnationId: h.inc('x'),
      reportSeq: 2,
      observation: { now: view('done', 9), onExit: null }
    }
    h.ingress.reconnected('x', snapshot)
    expect(h.visibleAt(P)?.shown.summary.aggregate).toBe('done')
    h.published()
    h.ingress.reconnected('x', snapshot)
    expect(h.published()).toEqual([])
  })

  it('4: link loss and reconnect while closed come back as live', () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.retire(P)
    h.ingress.lost('x')
    h.ingress.reconnected('x', {
      incarnationId: h.inc('x'),
      reportSeq: 1,
      observation: { now: view('working', 1), onExit: null }
    })
    h.restore(P, 'x')
    expect(h.visibleAt(P)?.liveness).toBe('live')
  })

  it('5: a closed tab accepts nothing; the same PTY bound under a new tab shows there', () => {
    const h = harness()
    const P = h.pane('a')
    const Q = h.pane('b')
    h.spawn('x', P, 'working')
    onHandlers.get('agentStatus:dropByTabPrefix')!({}, P.split(':')[0])
    h.published()
    h.restore(P, 'x')
    expect(h.slotAt(P)).toBeUndefined()
    expect(h.published()).toEqual([])
    rememberPaneKeyForPty('x', Q)
    h.restore(Q, 'x')
    expect(h.visibleAt(Q)).toMatchObject({ ptyId: 'x', reportSeq: 1 })
  })

  it('6: a pane rebound to a different silent PTY drops the old slot and shows nothing new', () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    rememberPaneKeyForPty('y', P)
    h.published()
    h.restore(P, 'y')
    expect(h.slotAt(P)).toBeUndefined()
    expect(h.published()).toEqual([[P, null]])
    // The detached ledger is not attributed to that pane again by the lazy rule.
    h.local.observe('x', report('state=done'), 3_000)
    expect(h.slotAt(P)).toBeUndefined()
  })

  it('7: a dismissal survives retire and restore; a later real transition shows', () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'done')
    h.dismiss(P)
    h.retire(P)
    h.restore(P, 'x')
    expect(h.hiddenAt(P)).toBe(true)
    h.local.observe('x', report('state=working'), 3_000)
    expect(h.visibleAt(P)?.shown.summary.aggregate).toBe('working')
  })

  it('8: leaf move, source retire, target bind: at the target, not the source, still dismissed', async () => {
    const h = harness()
    const from = h.pane('src')
    const to = h.pane('dst')
    h.spawn('x', from, 'done')
    h.dismiss(from)
    await h.leafMove('src', 'dst', 'x')
    h.retire(from)
    expect(h.slotAt(from)).toBeUndefined()
    h.restore(to, 'x')
    expect(h.hiddenAt(to)).toBe(true)
    expect(h.slotAt(from)).toBeUndefined()
    h.local.observe('x', report('state=error'), 3_000)
    expect(h.visibleAt(to)?.shown.summary.aggregate).toBe('error')
  })

  it('8: an exit between the leaf move and the target bind lands on the moved slot', async () => {
    const h = harness()
    const from = h.pane('src')
    const to = h.pane('dst')
    h.spawn('x', from)
    h.local.observe('x', report('state=working') + report('state=done:id=child'), 2_000)
    await h.leafMove('src', 'dst', 'x')
    h.local.exit('x', true)
    expect(h.slotAt(from)).toBeUndefined()
    expect(h.visibleAt(to)).toMatchObject({ liveness: 'exited', view: 'onExit' })
    h.published()
    h.restore(to, 'x')
    expect(h.visibleAt(to)).toMatchObject({ liveness: 'exited', view: 'onExit' })
    expect(h.published()).toEqual([])
  })

  it('9: a restore with no prior closure, repeated ten times, publishes nothing', () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.published()
    for (let index = 0; index < 10; index += 1) {
      h.restore(P, 'x')
    }
    expect(h.published()).toEqual([])
  })

  it('10: after a renderer reload the snapshot pull has the slot and the bind adds nothing', () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.published()
    const pulled = handleHandlers.get('agentStatus:getSnapshot')!({})
    expect(pulled).toEqual(
      expect.arrayContaining([expect.objectContaining({ paneKey: P, programStatusOnly: true })])
    )
    h.restore(P, 'x')
    expect(h.published()).toEqual([])
  })
})

describe('binding proof before any mutation', () => {
  /** X shows `working` at its pane, Y shows `done` at its own; neither may be disturbed. */
  function refused(
    h: ReturnType<typeof harness>,
    xPane: string,
    yPane: string,
    restorePane: string
  ) {
    const before = [h.slotAt(xPane), h.slotAt(yPane)]
    h.published()
    h.restore(restorePane, 'x')
    expect(h.published()).toEqual([])
    expect([h.slotAt(xPane), h.slotAt(yPane)]).toEqual(before)
  }

  it('11a: the PTY is bound to another pane (conjunct 2)', () => {
    const h = harness()
    const P = h.pane('a')
    const Q = h.pane('b')
    h.spawn('x', P, 'working')
    h.spawn('y', Q, 'done')
    refused(h, P, Q, Q)
    expect(h.visibleAt(Q)?.ptyId).toBe('y')
  })

  it('11b: the pane was rebound to a live Y while X lives (conjunct 1)', () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.spawn('y', P, 'done')
    expect(ptyPaneKey.get('x')).toBe(P)
    expect(paneKeyPtyId.get(P)).toBe('y')
    refused(h, P, P, P)
    expect(h.visibleAt(P)?.ptyId).toBe('y')
  })

  it('11b: a PTY spawned at the moved source key, after the move (conjunct 1 alone)', async () => {
    const h = harness()
    const from = h.pane('src')
    const to = h.pane('dst')
    h.spawn('x', from, 'working')
    await h.leafMove('src', 'dst', 'x')
    rememberPaneKeyForPty('y', from)
    expect([paneKeyPtyId.get(to), agentHookServer.resolveProgramStatusPaneKey(from)]).toEqual([
      undefined,
      to
    ])
    refused(h, from, to, to)
  })

  it('11c: Y spawned at a leaf-move target, the moved X resolves there by alias (conjunct 3)', async () => {
    const h = harness()
    const from = h.pane('src')
    const to = h.pane('dst')
    h.spawn('x', from, 'working')
    await h.leafMove('src', 'dst', 'x')
    expect(agentHookServer.resolveProgramStatusPaneKey(from)).toBe(to)
    h.spawn('y', to, 'done')
    refused(h, from, to, to)
    expect(h.visibleAt(to)?.ptyId).toBe('y')
  })

  it('11d: the legitimate pairs pass all three conjuncts at once and apply in the same turn', async () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.retire(P)
    h.restore(P, 'x')
    expect(h.visibleAt(P)?.ptyId).toBe('x')
    const from = h.pane('src')
    const to = h.pane('dst')
    h.spawn('z', from, 'working')
    await h.leafMove('src', 'dst', 'z')
    h.retire(from)
    h.restore(to, 'z')
    expect(h.visibleAt(to)?.ptyId).toBe('z')
  })

  it('12: a stale parked request is superseded by a newer restore of the same pane', async () => {
    const h = harness()
    const old = h.pane('old')
    const P = h.pane('a')
    h.spawn('x', old, 'working')
    h.spawn('y', h.pane('y-home'), 'done')
    h.restore(P, 'x')
    h.restore(P, 'y')
    rememberPaneKeyForPty('x', P)
    await flushMicrotasks()
    expect(h.slotAt(P)).toBeUndefined()
    expect(h.visibleAt(old)?.ptyId).toBe('x')
    rememberPaneKeyForPty('y', P)
    await flushMicrotasks()
    expect(h.visibleAt(P)?.ptyId).toBe('y')
    expect(h.visibleAt(old)?.ptyId).toBe('x')
  })

  it('13: a restore handled before the leaf move committed parks, then applies at the target', async () => {
    const h = harness()
    const from = h.pane('src')
    const to = h.pane('dst')
    h.spawn('x', from, 'done')
    h.dismiss(from)
    h.restore(to, 'x')
    expect(h.slotAt(to)).toBeUndefined()
    const moving = h.leafMove('src', 'dst', 'x')
    expect(h.slotAt(to)).toBeUndefined()
    await moving
    expect(h.hiddenAt(to)).toBe(true)
    expect(h.slotAt(from)).toBeUndefined()
    expect([...ptyPaneKey, ...paneKeyPtyId]).toEqual([
      ['x', from],
      [from, 'x']
    ])
  })

  it('13: a parked request a retire of its pane superseded never applies', async () => {
    const h = harness()
    const P = h.pane('a')
    const home = h.pane('home')
    h.spawn('x', home, 'working')
    h.restore(P, 'x')
    h.retire(P)
    rememberPaneKeyForPty('x', P)
    await flushMicrotasks()
    expect(h.slotAt(P)).toBeUndefined()
    // Not adopted: the slot never left the pane the lazy rule gave it.
    expect(h.visibleAt(home)?.ptyId).toBe('x')
  })

  it('14: a restore before the spawn commit names the pair applies exactly once, after it', async () => {
    const h = harness()
    const P = h.pane('a')
    h.targets.set('x', { paneKey: h.pane('lazy'), worktreeId: 'wt-1' })
    h.local.begin('x', h.inc('x'))
    h.local.observe('x', report('state=working'), 2_000)
    h.restore(P, 'x')
    h.published()
    rememberPaneKeyForPty('x', P)
    // Why deferred: the commit registers its alias after remembering the key.
    expect(h.slotAt(P)).toBeUndefined()
    await flushMicrotasks()
    expect(h.visibleAt(P)?.ptyId).toBe('x')
    rememberPaneKeyForPty('x', P)
    await flushMicrotasks()
    expect(h.published().filter(([key]) => key === P)).toHaveLength(1)
    // The adoption stands: the lazy rule moves the ledger again only on a later leaf change.
    h.local.observe('x', report('state=done'), 3_000)
    expect(h.visibleAt(P)?.shown.summary.aggregate).toBe('done')
    expect(h.slotAt(h.pane('lazy'))).toBeUndefined()
  })

  it('15: a restore after the spawn commit satisfies the ordering; before it, it parks', async () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.retire(P)
    h.restore(P, 'x')
    expect(h.visibleAt(P)?.ptyId).toBe('x')
    const Q = h.pane('b')
    h.targets.set('y', { paneKey: Q, worktreeId: 'wt-1' })
    h.local.begin('y', h.inc('y'))
    h.local.observe('y', report('state=done'), 2_000)
    h.retire(Q)
    h.restore(Q, 'y')
    expect(h.slotAt(Q)).toBeUndefined()
    rememberPaneKeyForPty('y', Q)
    await flushMicrotasks()
    expect(h.visibleAt(Q)?.ptyId).toBe('y')
  })

  it('19: an alias-reminted spawn key passes at once and nothing parks', () => {
    const h = harness()
    const P = h.pane('a')
    const reminted = makePaneKey(`t${suite}-a`, OTHER_LEAF)
    h.spawn('x', P, 'working')
    agentHookServer.registerPaneKeyAlias(reminted, P, 'x', Date.now(), { authorityVerified: true })
    h.retire(P)
    h.restore(P, 'x')
    expect(h.visibleAt(P)?.ptyId).toBe('x')
  })

  it('a malformed restore argument changes nothing and keeps the hook-side restore', async () => {
    const h = harness()
    const P = h.pane('a')
    h.spawn('x', P, 'working')
    h.retire(P)
    const restore = vi.spyOn(agentHookServer, 'restorePaneAuthority')
    for (const ptyId of [undefined, 7, '', ' x', 'x'.repeat(513)]) {
      h.restore(P, ptyId)
    }
    expect(h.slotAt(P)).toBeUndefined()
    expect(restore).toHaveBeenCalledTimes(5)
    // Nor does it displace a parked request of the same pane.
    const Q = h.pane('b')
    h.targets.set('y', { paneKey: h.pane('y-lazy'), worktreeId: 'wt-1' })
    h.local.begin('y', h.inc('y'))
    h.local.observe('y', report('state=done'), 2_000)
    h.restore(Q, 'y')
    h.restore(Q, ' y')
    rememberPaneKeyForPty('y', Q)
    await flushMicrotasks()
    expect(h.visibleAt(Q)?.ptyId).toBe('y')
  })
})

describe('the expiry instant across a restore', () => {
  it('unverifiable at T, retire at T+10, restore at T+20: stale at T+30, not T+50', () => {
    const h = harness()
    const P = h.pane('a')
    const T = 10 * MINUTE
    h.spawn('x', P, 'working')
    h.setClock(T)
    h.ingress.lost('x')
    h.setClock(T + 10 * MINUTE)
    h.retire(P)
    h.setClock(T + 20 * MINUTE)
    h.restore(P, 'x')
    const slot = h.visibleAt(P)!
    expect(composedEntryStaleAt(programStatusEntryFromSlot({ paneKey: P, slot }))).toBe(
      T + AGENT_STATUS_STALE_AFTER_MS
    )
  })
})

describe("today's map readers are unchanged by the leaf-move notification", () => {
  it('17: both maps keep the spawn key after a move; exit teardown clears what it cleared', async () => {
    const h = harness()
    const from = h.pane('src')
    h.spawn('x', from, 'working')
    await h.leafMove('src', 'dst', 'x')
    await flushMicrotasks()
    expect([...ptyPaneKey]).toEqual([['x', from]])
    expect([...paneKeyPtyId]).toEqual([[from, 'x']])
    const clearPaneState = vi.spyOn(agentHookServer, 'clearPaneState')
    clearProviderPtyState('x')
    expect(clearPaneState.mock.calls).toEqual([[from, { forgetAgentExit: true }]])
    expect([...ptyPaneKey, ...paneKeyPtyId]).toEqual([])
    expect(agentHookServer.resolveProgramStatusPaneKey(from)).toBe(from)
  })

  it('18: a hook working event of the moved pane drives the same synthetic title', async () => {
    const h = harness()
    const from = h.pane('src')
    h.spawn('x', from)
    await h.leafMove('src', 'dst', 'x')
    await flushMicrotasks()
    const ingestSyntheticTitleFrame = vi.fn()
    const window = {
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      webContents: { send: vi.fn() }
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the title path reads only these members.
    Object.assign(mainProcessState, {
      mainWindow: window,
      runtime: { ingestSyntheticTitleFrame }
    } as never)
    const profile = { workingLabel: 'Working', idleLabel: 'Idle', permissionLabel: 'Needs input' }
    driveSyntheticTitleFromHook(from, 'working', profile)
    driveSyntheticTitleFromHook(from, 'done', profile)
    expect(ingestSyntheticTitleFrame.mock.calls).toEqual([
      ['x', '\x1b]0;⠋ Working\x07'],
      ['x', '\x1b]0;Idle\x07']
    ])
    Object.assign(mainProcessState, { mainWindow: null, runtime: null })
  })
})
