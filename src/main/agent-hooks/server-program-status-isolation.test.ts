import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { ProgramStatusPaneIpcPayload } from '../../shared/program-status/program-status-pane-payload'
import type {
  ProgramStatusIdentity,
  ProgramStatusReportWrite,
  ProgramStatusView
} from '../../shared/program-status/program-status-slot'
import { LEAF_1, LEAF_2 } from './server.test-fixtures'

const ipc = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => void>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    removeAllListeners: vi.fn(),
    on: (name: string, handler: (event: unknown, ...args: unknown[]) => void) =>
      ipc.handlers.set(name, handler)
  }
}))

import { AgentHookServer, agentHookServer } from './server'
import { registerAgentPaneAuthorityIpcHandlers } from '../ipc/agent-pane-authority-ipc'
import { registerAgentStatusRowTeardownIpcHandlers } from '../ipc/agent-status-row-teardown-ipc'

const PANE = makePaneKey('tab-1', LEAF_1)
const SIBLING = makePaneKey('tab-1', LEAF_2)
const PTY: ProgramStatusIdentity = { ptyId: 'pty-1', incarnationId: 'inc-1' }
const DONE: ProgramStatusView = {
  summary: { aggregate: 'done', root: 'done', childError: false },
  generation: 2,
  changedAt: 1_000,
  rootChangedAt: 1_000
}

function report(
  reportSeq: number,
  shown: ProgramStatusView | null = DONE
): ProgramStatusReportWrite {
  return {
    kind: 'report',
    identity: PTY,
    reportSeq,
    shown,
    liveness: 'live',
    livenessChangedAt: 10
  }
}

function hookRow(server: AgentHookServer, state: 'working' | 'done' = 'working'): void {
  server.ingestTerminalStatus({
    paneKey: PANE,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    connectionId: null,
    payload: { state, prompt: 'review the change', agentType: 'claude' }
  })
}

function slot(server: AgentHookServer, paneKey = PANE): void {
  server.ingestProgramStatusReport({
    paneKey,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    write: report(1)
  })
}

/** Everything a hook reader can observe, as plain data. */
function hookView(server: AgentHookServer) {
  const state = server._getStateForTests()
  return structuredClone({
    snapshot: server.getStatusSnapshot(),
    forPane: server.getStatusSnapshotForPane(PANE),
    changes: server.getStatusChangeSnapshot(),
    providerSessions: server.getProviderSessionIdentities(),
    canonical: server.getCanonicalStatusSnapshot(),
    rows: [...state.lastStatusByPaneKey.entries()],
    prompts: [...state.lastPromptByPaneKey.entries()],
    tools: [...state.lastToolByPaneKey.entries()]
  })
}

function hookEvents(server: AgentHookServer) {
  const events: string[] = []
  server.subscribeEnrichedStatus(() => events.push('enriched'))
  server.subscribeStatusChanges(() => events.push('changes'))
  server.subscribeStatusFreshness(() => events.push('freshness'))
  server.subscribeStatusRowMutations(() => events.push('mutation'))
  server.subscribePaneStatusClear(() => events.push('clear'))
  server.subscribeStatusDrop(() => events.push('drop'))
  return events
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-program-status-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the slot is never a hook row', () => {
  it('a 7501-only pane has no hook row, no default snapshot row and no hook event', () => {
    const server = new AgentHookServer()
    const events = hookEvents(server)
    const before = hookView(server)
    slot(server)
    server.applyProgramStatusLifecycle(PANE, {
      kind: 'lifecycle',
      identity: PTY,
      liveness: 'unverifiable',
      livenessChangedAt: 20
    })
    expect(hookView(server)).toEqual(before)
    expect(server.getStatusSnapshot()).toEqual([])
    expect(server.getStatusSnapshotForPane(PANE)).toEqual([])
    expect(events).toEqual([])
    expect(server.getProgramStatusSnapshot()).toHaveLength(1)
  })

  it('the hook listener replay never carries a slot', () => {
    const server = new AgentHookServer()
    slot(server)
    const replayed: unknown[] = []
    server.setListener((payload) => replayed.push(payload))
    expect(replayed).toEqual([])
  })

  it.each([true, false])(
    'is not persisted to last-status.json (hook row: %s)',
    async (withHook) => {
      const server = new AgentHookServer()
      await server.start({ env: 'production', userDataPath: dir })
      const file = join(dir, 'agent-hooks', 'last-status.json')
      const persisted = () => {
        server.flushStatusPersistSync()
        return existsSync(file) ? readFileSync(file, 'utf8') : null
      }
      try {
        if (withHook) {
          hookRow(server)
        }
        const before = persisted()
        slot(server, PANE)
        slot(server, SIBLING)
        expect(persisted()).toBe(before)
        expect(before ?? '').not.toContain('programStatus')
      } finally {
        server.stop()
      }
    }
  )
})

describe('no hook lifecycle path touches the slot', () => {
  const paths: [string, (server: AgentHookServer) => void][] = [
    ['clearPaneState', (server) => server.clearPaneState(PANE)],
    [
      'reconcileEndedProcessForPaneKeys',
      (server) => server.reconcileEndedProcessForPaneKeys([PANE])
    ],
    ['dropStatusEntry', (server) => server.dropStatusEntry(PANE)],
    ['retirePaneAuthority', (server) => server.retirePaneAuthority(PANE)],
    [
      'retire then restorePaneAuthority',
      (server) => {
        server.retirePaneAuthority(PANE)
        server.restorePaneAuthority(PANE)
      }
    ],
    [
      'retire then a new-turn revival',
      (server) => {
        server.retirePaneAuthority(PANE)
        server.ingestRemote(
          {
            paneKey: PANE,
            tabId: 'tab-1',
            worktreeId: 'wt-1',
            source: 'claude',
            hookEventName: 'UserPromptSubmit',
            payload: { state: 'working', prompt: 'next', agentType: 'claude' }
          },
          'conn-a'
        )
      }
    ]
  ]

  it.each(paths)('%s leaves the slot byte-identical and publishes no slot row', (_name, run) => {
    const server = new AgentHookServer()
    hookRow(server)
    slot(server)
    const rows: ProgramStatusPaneIpcPayload[] = []
    server.setProgramStatusListener((row) => rows.push(row))
    const before = structuredClone(server.getProgramStatusSnapshot())
    rows.length = 0
    run(server)
    expect(server.getProgramStatusSnapshot()).toEqual(before)
    expect(rows).toEqual([])
    // The pane stays open to the slot: a later report still lands.
    expect(server.ingestProgramStatusReport({ paneKey: PANE, write: report(2) })).toBe(true)
  })
})

describe('no slot path touches the hook row', () => {
  const operations: [string, (server: AgentHookServer) => void][] = [
    ['report', (server) => slot(server)],
    [
      'lifecycle',
      (server) =>
        server.applyProgramStatusLifecycle(PANE, {
          kind: 'lifecycle',
          identity: PTY,
          liveness: 'exited',
          livenessChangedAt: 30,
          shown: DONE,
          prevNow: DONE
        })
    ],
    [
      'acknowledge',
      (server) =>
        server.acknowledgeProgramStatus(PANE, {
          incarnationId: PTY.incarnationId,
          view: 'now',
          generation: DONE.generation
        })
    ],
    ['rekey', (server) => server.rekeyProgramStatus(PANE, { paneKey: SIBLING }, PTY, report(1))],
    ['forget', (server) => server.forgetProgramStatus(PANE, PTY, { ptyRetired: true })],
    ['close', (server) => server.closeProgramStatusPane(PANE)],
    ['reopen', (server) => server.reopenProgramStatusPane(PANE)],
    ['close another tab', (server) => server.closeProgramStatusTab('tab-9')],
    ['removed worktree', (server) => server.forgetProgramStatusForRemovedWorktree('wt-1', 'local')]
  ]

  it.each(operations)('%s leaves every hook reader and listener unchanged', (_name, run) => {
    const server = new AgentHookServer()
    hookRow(server)
    if (_name !== 'report') {
      slot(server)
    }
    const before = hookView(server)
    const events = hookEvents(server)
    run(server)
    expect(hookView(server)).toEqual(before)
    expect(events).toEqual([])
  })
})

describe('renderer-originated closure reaches the slot through the IPC handlers', () => {
  beforeEach(() => {
    ipc.handlers.clear()
    registerAgentPaneAuthorityIpcHandlers({ ownsPty: () => false })
    registerAgentStatusRowTeardownIpcHandlers()
  })

  const send = (channel: string, ...args: unknown[]) => ipc.handlers.get(channel)?.({}, ...args)
  const paneOf = (tabId: string) => makePaneKey(tabId, LEAF_1)
  const slotAt = (paneKey: string) =>
    agentHookServer.getProgramStatusSnapshot().find((row) => row.paneKey === paneKey)

  it('the retire handler closes the slot pane and the restore handler reopens it', () => {
    const paneKey = paneOf('tab-ipc-retire')
    agentHookServer.ingestProgramStatusReport({ paneKey, write: report(1) })
    send('agentStatus:retirePaneAuthority', paneKey)
    expect(slotAt(paneKey)).toBeUndefined()
    expect(agentHookServer.ingestProgramStatusReport({ paneKey, write: report(2) })).toBe(false)
    send('agentStatus:restorePaneAuthority', paneKey)
    expect(agentHookServer.ingestProgramStatusReport({ paneKey, write: report(2) })).toBe(true)
    agentHookServer.forgetProgramStatus(paneKey, PTY, { ptyRetired: true })
  })

  it('an invalid pane key reaches no slot operation', () => {
    const paneKey = paneOf('tab-ipc-invalid')
    agentHookServer.ingestProgramStatusReport({ paneKey, write: report(1) })
    send('agentStatus:retirePaneAuthority', 'not a pane key')
    send('agentStatus:retirePaneAuthority', paneKey, 'not-a-uuid')
    expect(slotAt(paneKey)?.programStatus).not.toBeNull()
    agentHookServer.forgetProgramStatus(paneKey, PTY, { ptyRetired: true })
  })

  it('the tab-close handler forgets the tab and keeps it refused', () => {
    const paneKey = paneOf('tab-ipc-close')
    agentHookServer.ingestProgramStatusReport({ paneKey, tabId: 'tab-ipc-close', write: report(1) })
    send('agentStatus:dropByTabPrefix', 'tab-ipc-close')
    expect(slotAt(paneKey)).toBeUndefined()
    send('agentStatus:restorePaneAuthority', paneKey)
    expect(agentHookServer.ingestProgramStatusReport({ paneKey, write: report(2) })).toBe(false)
  })
})

describe('worktree removal is wired into the slot', () => {
  it('the runtime removal dependency forgets program-status records too', () => {
    const source = readFileSync(join(import.meta.dirname, 'agent-hook-runtime-deps.ts'), 'utf8')
    const start = source.indexOf('dropAgentStatusForRemovedWorktree:')
    expect(start).toBeGreaterThanOrEqual(0)
    const wiring = source.slice(start, source.indexOf('buildAgentHookPtyEnv', start))
    expect(wiring).toContain('server.dropStatusEntriesForRemovedWorktree(worktreeId, host)')
    expect(wiring).toContain('server.forgetProgramStatusForRemovedWorktree(worktreeId, host)')
  })
})
