import {
  pickParsedAgentStatusPayload,
  type AgentStatusIpcPayload,
  type ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { parseLegacyNumericPaneKey, parsePaneKey } from '../../shared/stable-pane-id'
import { agentVerdictFields } from '../../shared/agent-main-agent-verdict'
import { isLocalHookConnectionId } from '../../shared/wsl-hook-relay-contract'
import type { AgentSessionStatusSummary } from '../../shared/agent-session-wire'
import {
  structuredAgentSessionPaneKey,
  structuredAgentSessionTabId
} from '../../shared/structured-agent-session-projection'
import type { RuntimeWorktreeAgentSource } from './runtime-worktree-agent-source'
import {
  composeAgentStatusEntry,
  programStatusEntryFromSlot,
  type ProgramStatusPreference
} from '../../shared/program-status/compose-agent-status-entry'
import type { ProgramStatusPaneIpcPayload } from '../../shared/program-status/program-status-pane-payload'

export type ConnectedPtyEvidence = {
  tabIds: ReadonlySet<string>
  paneKeys: ReadonlySet<string>
  /** The connected PTY behind each issued terminal handle. A status row names a pane and the
   *  handle it was observed under, never a process, so this is where it rejoins its terminal —
   *  and it is the only rescue left for a row whose pane binding was cleared under it. */
  ptyIdByTerminalHandle: ReadonlyMap<string, string>
}

/** Join only the host-owned summary of this exact chat, never a remote pane with a similar id. */
function publishedStructuredChildren(
  entry: AgentStatusIpcPayload,
  read: ((sessionId: string) => AgentSessionStatusSummary | undefined) | undefined
) {
  const prefix = structuredAgentSessionTabId('')
  const tabId = entry.tabId
  if (!read || !entry.structuredHost || entry.connectionId !== null || !tabId?.startsWith(prefix)) {
    return undefined
  }
  const sessionId = tabId.slice(prefix.length)
  if (entry.paneKey !== structuredAgentSessionPaneKey(tabId, sessionId)) {
    return undefined
  }
  const summary = read(sessionId)
  return summary?.workspaceId === entry.worktreeId ? (summary?.children ?? []) : undefined
}

/** Present only for a caller that opted in; the host's own setting picks the winner. */
export type RuntimeProgramStatusComposition = {
  rows: readonly ProgramStatusPaneIpcPayload[]
  preference: ProgramStatusPreference
}

/** The panes a visible slot wins, as display-only sources: no agent identity, prompt or tool. */
function programStatusWonSources(
  hooks: readonly AgentStatusIpcPayload[],
  composition: RuntimeProgramStatusComposition | undefined
): Map<string, RuntimeWorktreeAgentSource> {
  const won = new Map<string, RuntimeWorktreeAgentSource>()
  if (!composition) {
    return won
  }
  const hookByPane = new Map(hooks.map((hook) => [hook.paneKey, hook]))
  for (const { paneKey, tabId, worktreeId, programStatus } of composition.rows) {
    if (!programStatus) {
      continue
    }
    const atPane = { paneKey, tabId, worktreeId, slot: programStatus }
    const hook = hookByPane.get(paneKey)
    if (composeAgentStatusEntry(hook, atPane, composition.preference) === hook) {
      continue
    }
    const entry = programStatusEntryFromSlot(atPane)
    won.set(paneKey, {
      paneKey,
      tabId,
      worktreeId,
      connectionId: null,
      state: entry.state,
      agentType: null,
      prompt: '',
      lastAssistantMessage: null,
      toolName: null,
      toolInput: null,
      interrupted: false,
      ...agentVerdictFields(entry),
      stateStartedAt: entry.stateStartedAt,
      updatedAt: entry.evidenceObservedAt ?? entry.updatedAt,
      ...(entry.programStatusLive ? { programStatusLive: true as const } : {})
    })
  }
  return won
}

/** Admit hook-server rows, and opted-in program-status slots, using execution-host evidence. */
export function collectRuntimeWorktreePtyAgentSources(args: {
  hookSnapshots: readonly AgentStatusIpcPayload[]
  readStructuredSummary?: (sessionId: string) => AgentSessionStatusSummary | undefined
  programStatus?: RuntimeProgramStatusComposition
  mirroredWorktreeIdByTabId: ReadonlyMap<string, string>
  connectedPtyEvidence: ConnectedPtyEvidence
}): RuntimeWorktreeAgentSource[] {
  const rowSources = new Map<
    string,
    RuntimeWorktreeAgentSource & { payload?: ParsedAgentStatusPayload }
  >(programStatusWonSources(args.hookSnapshots, args.programStatus))
  for (const entry of args.hookSnapshots) {
    if (
      entry.restoredUnconfirmed === true ||
      entry.providerSessionOnly === true ||
      rowSources.has(entry.paneKey)
    ) {
      continue
    }
    const hookPayload = pickParsedAgentStatusPayload(entry)
    const children = publishedStructuredChildren(entry, args.readStructuredSummary)
    rowSources.set(entry.paneKey, {
      paneKey: entry.paneKey,
      ptyId: entry.terminalHandle
        ? args.connectedPtyEvidence.ptyIdByTerminalHandle.get(entry.terminalHandle)
        : undefined,
      tabId: entry.tabId,
      worktreeId: entry.worktreeId,
      connectionId: entry.connectionId,
      payload: hookPayload,
      state: entry.state,
      ...(entry.workingMode ? { workingMode: entry.workingMode } : {}),
      agentType: entry.agentType ?? null,
      prompt: entry.prompt,
      lastAssistantMessage: entry.lastAssistantMessage ?? null,
      toolName: entry.toolName ?? null,
      toolInput: entry.toolInput ?? null,
      interrupted: false,
      ...agentVerdictFields(entry),
      stateStartedAt: entry.stateStartedAt,
      // A replay advances delivery order, not the age of the evidence shown by worktree.ps.
      updatedAt: entry.evidenceObservedAt ?? entry.receivedAt,
      ...(children !== undefined ? { children } : {}),
      ...(entry.subagents !== undefined ? { subagents: entry.subagents } : {}),
      ...(entry.structuredHost ? { structuredHost: entry.structuredHost } : {})
    })
  }
  const sources: RuntimeWorktreeAgentSource[] = []
  for (const source of rowSources.values()) {
    const tabId =
      source.tabId ??
      parsePaneKey(source.paneKey)?.tabId ??
      parseLegacyNumericPaneKey(source.paneKey)?.tabId
    const mirroredWorktreeId = tabId ? args.mirroredWorktreeIdByTabId.get(tabId) : undefined
    // Why a structured row skips the connected-process gate: it has no PTY, and the host that
    // holds the session drops the row itself on close, so its presence is the liveness evidence.
    if (
      source.structuredHost === undefined &&
      tabId !== undefined &&
      mirroredWorktreeId === undefined &&
      isLocalHookConnectionId(source.connectionId) &&
      !args.connectedPtyEvidence.tabIds.has(tabId) &&
      !args.connectedPtyEvidence.paneKeys.has(source.paneKey) &&
      // Resolved only from a connected PTY's handle, so its presence is the liveness evidence.
      source.ptyId === undefined
    ) {
      continue
    }
    const worktreeId = mirroredWorktreeId ?? source.worktreeId
    sources.push({ ...source, tabId, worktreeId })
  }
  return sources
}
