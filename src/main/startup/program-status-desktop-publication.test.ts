import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import type { DashboardCard } from '../../shared/dashboard-snapshot'
import type {
  ProgramStatusAck,
  ProgramStatusIdentity,
  ProgramStatusReportWrite
} from '../../shared/program-status/program-status-slot'
import { isProgramStatusPanePayload } from '../../shared/program-status/program-status-pane-payload'

const electron = vi.hoisted(() => ({
  on: new Map<string, (event: unknown, ...args: unknown[]) => void>(),
  handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  rendererSends: new Array<unknown[]>(),
  popoutSends: new Array<unknown[]>(),
  titles: new Array<unknown>()
}))
vi.mock('electron', () => ({
  app: { getPath: () => '', on: vi.fn(), isReady: () => true },
  ipcMain: {
    on: (channel: string, handler: (event: unknown, ...args: unknown[]) => void) =>
      electron.on.set(channel, handler),
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) =>
      electron.handle.set(channel, handler),
    removeHandler: vi.fn(),
    removeAllListeners: vi.fn()
  },
  ipcRenderer: { send: (...args: unknown[]) => electron.rendererSends.push(args) }
}))
vi.mock('../window/dashboard-popout-window', () => ({
  getDashboardPopoutWindow: () => ({
    webContents: { send: (...args: unknown[]) => electron.popoutSends.push(args) }
  })
}))
vi.mock('./synthetic-title-runtime', () => ({
  driveSyntheticTitleFromHook: (...args: unknown[]) => electron.titles.push(args),
  stopSyntheticTitleSpinnerTimer: vi.fn()
}))

import { agentHookServer } from '../agent-hooks/server'
import { registerAgentHookHandlers } from '../ipc/agent-hooks'
import { isDashboardSnapshot } from '../ipc/dashboard-payload-validation'
import { agentStatusApi } from '../../preload/api/agent-status-bridge'
import {
  clearMainWindowAgentStatusListeners,
  installMainWindowAgentStatusListeners
} from './main-window-agent-status'
import { mainProcessState } from './main-process-state'

const LEAF = '11111111-1111-4111-8111-111111111111'
const PTY: ProgramStatusIdentity = { ptyId: 'pty-pub', incarnationId: 'inc-pub' }
const DONE = {
  summary: { aggregate: 'done' as const, root: 'done' as const, childError: false },
  generation: 4,
  changedAt: 1_000,
  rootChangedAt: 1_000
}
const ACK: ProgramStatusAck = { incarnationId: 'inc-pub', view: 'now', generation: 4 }
let tabSeq = 0
let paneKey = ''

function report(reportSeq: number): ProgramStatusReportWrite {
  return {
    kind: 'report',
    identity: PTY,
    reportSeq,
    shown: DONE,
    liveness: 'live',
    livenessChangedAt: 5
  }
}

function writeSlot(): void {
  agentHookServer.ingestProgramStatusReport({
    paneKey,
    tabId: `tab-pub-${tabSeq}`,
    write: report(1)
  })
}

function writeHookRow(): void {
  agentHookServer.ingestTerminalStatus({
    paneKey,
    tabId: `tab-pub-${tabSeq}`,
    worktreeId: 'wt-pub',
    connectionId: null,
    payload: { state: 'working', prompt: 'ship it', agentType: 'claude' }
  })
}

function fakeWindow(destroyed: boolean): typeof mainProcessState.mainWindow {
  const window = {
    isDestroyed: () => destroyed,
    webContents: { send: (...args: unknown[]) => electron.rendererSends.push(args) }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the listener reads only isDestroyed and webContents.send, both provided.
  return window as unknown as typeof mainProcessState.mainWindow
}

const options = {
  maybeAutoRenameBranchOnFirstWork: vi.fn(),
  onRecordAgentState: vi.fn()
}

beforeEach(() => {
  tabSeq += 1
  paneKey = makePaneKey(`tab-pub-${tabSeq}`, LEAF)
  electron.rendererSends.length = 0
  electron.popoutSends.length = 0
  electron.titles.length = 0
  vi.clearAllMocks()
  // Why: the handlers reach the singleton store, so each test starts from an empty slot table.
  for (const row of agentHookServer.getProgramStatusSnapshot()) {
    agentHookServer.closeProgramStatusTab(row.tabId ?? '')
  }
  agentHookServer.forgetProgramStatus(paneKey, PTY, { ptyRetired: true })
  mainProcessState.runtime = null
  mainProcessState.mainWindow = fakeWindow(false)
})

describe('slot rows reach the desktop windows on the existing channel', () => {
  it('sends each slot row on agentStatus:set to the main window and the pop-out', () => {
    installMainWindowAgentStatusListeners({ window: mainProcessState.mainWindow!, ...options })
    writeSlot()
    const [channel, row] = electron.rendererSends.at(-1) ?? []
    expect(channel).toBe('agentStatus:set')
    expect(isProgramStatusPanePayload(row)).toBe(true)
    expect(row).toMatchObject({ paneKey, programStatus: { ptyId: 'pty-pub' } })
    expect(electron.popoutSends.at(-1)).toEqual(['agentStatus:set', row])
    clearMainWindowAgentStatusListeners()
  })

  it('drives no title, telemetry or branch rename', () => {
    installMainWindowAgentStatusListeners({ window: mainProcessState.mainWindow!, ...options })
    writeSlot()
    expect(electron.titles).toEqual([])
    expect(options.onRecordAgentState).not.toHaveBeenCalled()
    expect(options.maybeAutoRenameBranchOnFirstWork).not.toHaveBeenCalled()
    clearMainWindowAgentStatusListeners()
  })

  it('replays current slot rows on install and stops after the window listeners clear', () => {
    writeSlot()
    installMainWindowAgentStatusListeners({ window: mainProcessState.mainWindow!, ...options })
    const replayed = electron.rendererSends.filter(([, row]) => isProgramStatusPanePayload(row))
    expect(replayed).toHaveLength(1)
    clearMainWindowAgentStatusListeners()
    electron.rendererSends.length = 0
    agentHookServer.ingestProgramStatusReport({ paneKey, write: { ...report(2) } })
    expect(electron.rendererSends).toEqual([])
  })

  it('sends nothing into a destroyed main window', () => {
    installMainWindowAgentStatusListeners({ window: mainProcessState.mainWindow!, ...options })
    electron.rendererSends.length = 0
    electron.popoutSends.length = 0
    mainProcessState.mainWindow = fakeWindow(true)
    writeSlot()
    expect(electron.rendererSends).toEqual([])
    expect(electron.popoutSends).toEqual([])
    clearMainWindowAgentStatusListeners()
  })
})

describe('agentStatus:getSnapshot', () => {
  const snapshot = () => {
    registerAgentHookHandlers()
    const rows: unknown = electron.handle.get('agentStatus:getSnapshot')?.({})
    if (!Array.isArray(rows)) {
      throw new Error('expected snapshot rows')
    }
    return rows
  }

  it('appends slot rows after the enriched hook rows', () => {
    writeHookRow()
    writeSlot()
    const rows = snapshot()
    const hookIndex = rows.findIndex((row) => !isProgramStatusPanePayload(row))
    const slotIndex = rows.findIndex((row) => isProgramStatusPanePayload(row))
    expect(hookIndex).toBeGreaterThanOrEqual(0)
    expect(slotIndex).toBeGreaterThan(hookIndex)
    expect(rows.filter((row) => isProgramStatusPanePayload(row))).toHaveLength(1)
  })

  it('with no slot it returns exactly the hook rows it returned before', () => {
    writeHookRow()
    const rows = snapshot()
    expect(rows.some((row) => isProgramStatusPanePayload(row))).toBe(false)
    expect(rows).toEqual(
      agentHookServer
        .getStatusSnapshot()
        .filter((entry) => entry.structuredHost === undefined)
        .map((entry) => expect.objectContaining({ paneKey: entry.paneKey, state: entry.state }))
    )
  })
})

describe('agentStatus:drop with an acknowledgement', () => {
  const send = (...args: unknown[]) => {
    registerAgentHookHandlers()
    electron.on.get('agentStatus:drop')?.({}, ...args)
  }
  const slotRow = () =>
    agentHookServer.getProgramStatusSnapshot().find((row) => row.paneKey === paneKey)

  it('a valid acknowledgement hides the slot and never reaches the hook row', () => {
    writeHookRow()
    writeSlot()
    const hookBefore = agentHookServer.getStatusSnapshotForPane(paneKey)
    const drop = vi.spyOn(agentHookServer, 'dropStatusEntry')
    send(paneKey, ACK)
    expect(slotRow()?.programStatus).toBeNull()
    expect(drop).not.toHaveBeenCalled()
    expect(agentHookServer.getStatusSnapshotForPane(paneKey)).toEqual(hookBefore)
    drop.mockRestore()
  })

  it.each([
    ['a wrong view', { ...ACK, view: 'later' }],
    ['a zero generation', { ...ACK, generation: 0 }],
    ['an overlong incarnation', { ...ACK, incarnationId: 'x'.repeat(129) }],
    ['a non-object', 'ack'],
    ['null', null]
  ])('an invalid acknowledgement (%s) changes nothing at all', (_name, ack) => {
    writeHookRow()
    writeSlot()
    const drop = vi.spyOn(agentHookServer, 'dropStatusEntry')
    send(paneKey, ack)
    expect(drop).not.toHaveBeenCalled()
    expect(slotRow()?.programStatus).not.toBeNull()
    drop.mockRestore()
  })

  it('the one-argument call is today: it drops the hook row and leaves the slot', () => {
    writeHookRow()
    writeSlot()
    const drop = vi.spyOn(agentHookServer, 'dropStatusEntry')
    send(paneKey)
    expect(drop).toHaveBeenCalledTimes(1)
    expect(drop).toHaveBeenCalledWith(paneKey)
    expect(slotRow()?.programStatus).not.toBeNull()
    drop.mockRestore()
  })
})

describe('the preload drop', () => {
  it('sends the one-argument form unchanged and the acknowledgement only when given', () => {
    agentStatusApi.drop(paneKey)
    agentStatusApi.drop(paneKey, ACK)
    expect(electron.rendererSends).toEqual([
      ['agentStatus:drop', paneKey],
      ['agentStatus:drop', paneKey, ACK]
    ])
  })
})

describe('dashboard card validation', () => {
  const card = (extra: Partial<Record<keyof DashboardCard, unknown>>): unknown => ({
    generatedAt: 1,
    cards: [
      {
        paneKey: 'tab-1:leaf-1',
        ptyId: null,
        agentType: 'codex',
        bucket: 'working',
        dotState: 'working',
        task: 't',
        repoId: 'r',
        worktreeId: 'w',
        tabId: 'tab-1',
        leafId: null,
        repoName: 'R',
        worktreeName: 'W',
        startedAt: 1,
        finishedAt: null,
        stateChangedAt: 1,
        unseen: false,
        ...extra
      }
    ]
  })

  it('accepts the composition marker and a numeric or null expiry, and their absence', () => {
    expect(isDashboardSnapshot(card({}))).toBe(true)
    expect(isDashboardSnapshot(card({ programStatusComposed: true }))).toBe(true)
    expect(isDashboardSnapshot(card({ statusExpiresAt: null }))).toBe(true)
    expect(isDashboardSnapshot(card({ statusExpiresAt: 1_800_000 }))).toBe(true)
  })

  it.each([
    { programStatusComposed: false },
    { programStatusComposed: 'yes' },
    { statusExpiresAt: Number.NaN },
    { statusExpiresAt: '10' }
  ])('rejects %j', (extra) => {
    expect(isDashboardSnapshot(card(extra))).toBe(false)
  })
})
