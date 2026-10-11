import { describe, expect, it } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { RuntimeTerminalAgentStatusEvent } from './runtime-terminal-contracts'
import { resolveRuntimePtyPaneTargets } from './runtime-pty-pane-attribution'

const WORKTREE_ID = 'repo::/worktree'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const WORKING = '\x1b]9999;{"state":"working","agentType":"aider"}\x07'

function createRuntime(): {
  runtime: OrcaRuntimeService
  statuses: RuntimeTerminalAgentStatusEvent[]
  recordPty: (ptyId: string, state: Record<string, unknown>) => void
} {
  const statuses: RuntimeTerminalAgentStatusEvent[] = []
  const runtime = new OrcaRuntimeService(undefined, undefined, {
    onTerminalAgentStatus: (event) => statuses.push(event)
  })
  runtime.attachWindow(1)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: recordPtyWorktree is protected; it is the only way to give a PTY record a pane no leaf shows.
  const internals = runtime as unknown as {
    recordPtyWorktree: (ptyId: string, worktreeId: string, state: Record<string, unknown>) => void
  }
  const recordPty = (ptyId: string, state: Record<string, unknown>): void =>
    internals.recordPtyWorktree(ptyId, WORKTREE_ID, state)
  return { runtime, statuses, recordPty }
}

const targetOf = (event: RuntimeTerminalAgentStatusEvent) => ({
  source: event.source,
  paneKey: event.paneKey,
  tabId: event.tabId,
  worktreeId: event.worktreeId,
  connectionId: event.connectionId
})

describe('PTY pane attribution of agent status', () => {
  it('attributes to the mounted leaf showing the PTY, over its record', () => {
    const { runtime, statuses, recordPty } = createRuntime()
    recordPty('pty-1', { connected: true, tabId: 'tab-old', paneKey: `tab-old:${LEAF_ID}` })
    runtime.syncWindowGraph(1, {
      tabs: [
        { tabId: 'tab-1', worktreeId: WORKTREE_ID, title: 'T', activeLeafId: LEAF_ID, layout: null }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: WORKTREE_ID,
          leafId: LEAF_ID,
          paneRuntimeId: 1,
          ptyId: 'pty-1'
        }
      ]
    })

    runtime.onPtyData('pty-1', WORKING, 100)

    expect(statuses.map(targetOf)).toEqual([
      {
        source: 'mounted-leaf',
        paneKey: `tab-1:${LEAF_ID}`,
        tabId: 'tab-1',
        worktreeId: WORKTREE_ID,
        connectionId: null
      }
    ])
  })

  it("falls back to the PTY record's pane when no leaf shows the PTY", () => {
    const { runtime, statuses, recordPty } = createRuntime()
    recordPty('pty-2', { connected: true, tabId: 'tab-2', paneKey: `tab-2:${LEAF_ID}` })

    runtime.onPtyData('pty-2', WORKING, 100)

    expect(statuses.map(targetOf)).toEqual([
      {
        source: 'pty-record',
        paneKey: `tab-2:${LEAF_ID}`,
        tabId: 'tab-2',
        worktreeId: WORKTREE_ID,
        connectionId: null
      }
    ])
  })

  it('attributes nothing when neither a leaf nor the record names a pane', () => {
    const { runtime, statuses, recordPty } = createRuntime()
    recordPty('pty-3', { connected: true })

    runtime.onPtyData('pty-3', WORKING, 100)

    expect(statuses).toEqual([])
  })
})

describe('resolveRuntimePtyPaneTargets', () => {
  const record = { connectionId: 'ssh-1', paneKey: 'tab-r:leaf-r', tabId: null, worktreeId: 'wt-r' }
  const leaf = (tabId: string) => ({ tabId, worktreeId: 'wt-l', leafId: `leaf-${tabId}` })
  const paneKeyForLeaf = (l: ReturnType<typeof leaf>) => `${l.tabId}:${l.leafId}`

  it('keys one mounted-leaf target per leaf, carrying the record connection', () => {
    const targets = resolveRuntimePtyPaneTargets(record, [leaf('a'), leaf('b')], paneKeyForLeaf)

    expect([...targets.entries()]).toEqual([
      [
        'a:leaf-a',
        {
          source: 'mounted-leaf',
          paneKey: 'a:leaf-a',
          tabId: 'a',
          worktreeId: 'wt-l',
          connectionId: 'ssh-1'
        }
      ],
      [
        'b:leaf-b',
        {
          source: 'mounted-leaf',
          paneKey: 'b:leaf-b',
          tabId: 'b',
          worktreeId: 'wt-l',
          connectionId: 'ssh-1'
        }
      ]
    ])
  })

  it('falls back to the record pane, with a null tab read as absent', () => {
    const targets = resolveRuntimePtyPaneTargets(record, [], paneKeyForLeaf)

    expect([...targets.values()]).toEqual([
      {
        source: 'pty-record',
        paneKey: 'tab-r:leaf-r',
        tabId: undefined,
        worktreeId: 'wt-r',
        connectionId: 'ssh-1'
      }
    ])
  })

  it('returns no target without a leaf or a record pane', () => {
    expect(resolveRuntimePtyPaneTargets(undefined, [], paneKeyForLeaf).size).toBe(0)
    expect(
      resolveRuntimePtyPaneTargets({ ...record, paneKey: null }, [], paneKeyForLeaf).size
    ).toBe(0)
  })
})
