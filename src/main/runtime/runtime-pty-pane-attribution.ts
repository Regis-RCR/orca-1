import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

/** A pane a PTY's output is attributed to, and where that attribution came from. */
export type RuntimePtyPaneTarget = {
  source: 'mounted-leaf' | 'pty-record'
  paneKey: string
  tabId?: string
  worktreeId?: string
  connectionId?: string | null
  terminalHandle?: string
}

type RuntimePtyPaneRecord = Pick<
  RuntimePtyWorktreeRecord,
  'connectionId' | 'paneKey' | 'tabId' | 'worktreeId'
>
type RuntimePtyPaneLeaf = Pick<RuntimeLeafRecord, 'tabId' | 'worktreeId'>

/**
 * The panes a PTY's output belongs to, keyed by pane key: every mounted leaf showing it,
 * else the pane its record was spawned for, else none.
 */
export function resolveRuntimePtyPaneTargets<Leaf extends RuntimePtyPaneLeaf>(
  pty: RuntimePtyPaneRecord | undefined,
  leaves: readonly Leaf[],
  paneKeyForLeaf: (leaf: Leaf) => string
): Map<string, RuntimePtyPaneTarget> {
  const targets = new Map<string, RuntimePtyPaneTarget>()
  const connectionId = pty?.connectionId ?? null
  for (const leaf of leaves) {
    const paneKey = paneKeyForLeaf(leaf)
    targets.set(paneKey, {
      source: 'mounted-leaf',
      paneKey,
      tabId: leaf.tabId,
      worktreeId: leaf.worktreeId,
      connectionId
    })
  }
  if (targets.size === 0 && pty?.paneKey) {
    targets.set(pty.paneKey, {
      source: 'pty-record',
      paneKey: pty.paneKey,
      tabId: pty.tabId ?? undefined,
      worktreeId: pty.worktreeId,
      connectionId
    })
  }
  return targets
}
