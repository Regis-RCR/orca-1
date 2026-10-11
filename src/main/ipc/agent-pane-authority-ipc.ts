import { ipcMain } from 'electron'
import { isStablePaneId } from '../../shared/stable-pane-id'
import { agentHookServer, isValidPaneKey } from '../agent-hooks/server'
import { clearMigrationUnsupportedPtysForPaneKey } from '../agent-hooks/migration-unsupported-pty-state'
import { installedProgramStatusIngress } from '../program-status/program-status-local-ingest'

const MAX_PTY_ID_LENGTH = 512

export type AgentPaneAuthorityOwnership = {
  ownsPty: (paneKey: string, ptyId: string) => boolean
  /** Main's own maps name this pair on both sides; the program-status resync requires it. */
  bindsPane?: (paneKey: string, ptyId: string) => boolean
}

const isPtyId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= MAX_PTY_ID_LENGTH &&
  value.trim() === value

export function registerAgentPaneAuthorityIpcHandlers(
  ownership: AgentPaneAuthorityOwnership
): void {
  ipcMain.removeAllListeners('agentStatus:retirePaneAuthority')
  ipcMain.removeAllListeners('agentStatus:restorePaneAuthority')
  ipcMain.removeAllListeners('agentStatus:transferPaneAuthority')
  ipcMain.on('agentStatus:restorePaneAuthority', (_event, paneKey: unknown, ptyId?: unknown) => {
    if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
      return
    }
    try {
      agentHookServer.restorePaneAuthority(paneKey)
      agentHookServer.reopenProgramStatusPane(paneKey)
      // Why: lifting the closure never restores what it dropped; a silent program would stay hidden.
      if (isPtyId(ptyId) && ownership.bindsPane) {
        installedProgramStatusIngress()?.ingress.resyncPane(paneKey, ptyId, ownership.bindsPane)
      }
    } catch (err) {
      console.warn('[agent-hooks] restorePaneAuthority failed:', err)
    }
  })
  ipcMain.on(
    'agentStatus:retirePaneAuthority',
    (_event, paneKey: unknown, retirementId: unknown) => {
      if (typeof paneKey !== 'string' || !isValidPaneKey(paneKey)) {
        return
      }
      try {
        if (
          retirementId !== undefined &&
          (typeof retirementId !== 'string' || !isStablePaneId(retirementId))
        ) {
          return
        }
        agentHookServer.retirePaneAuthority(paneKey, retirementId)
        clearMigrationUnsupportedPtysForPaneKey(paneKey)
        agentHookServer.closeProgramStatusPane(paneKey)
        installedProgramStatusIngress()?.ingress.retirePane(paneKey)
      } catch (err) {
        console.warn('[agent-hooks] retirePaneAuthority failed:', err)
      }
    }
  )
  ipcMain.on('agentStatus:transferPaneAuthority', (_event, value: unknown) => {
    if (!value || typeof value !== 'object') {
      return
    }
    const args = value as Record<string, unknown>
    const ptyId = typeof args.ptyId === 'string' ? args.ptyId : undefined
    if (
      typeof args.fromPaneKey !== 'string' ||
      typeof args.toPaneKey !== 'string' ||
      !isValidPaneKey(args.fromPaneKey) ||
      !isValidPaneKey(args.toPaneKey) ||
      args.fromPaneKey === args.toPaneKey ||
      (args.ptyId !== undefined &&
        (typeof args.ptyId !== 'string' ||
          args.ptyId.length > MAX_PTY_ID_LENGTH ||
          args.ptyId.trim() !== args.ptyId ||
          args.ptyId.length === 0)) ||
      !agentHookServer.canTransferPaneAuthority(args.fromPaneKey, ptyId, ownership.ownsPty)
    ) {
      return
    }
    try {
      agentHookServer.transferPaneAuthority(args.fromPaneKey, args.toPaneKey, ptyId)
    } catch (err) {
      console.warn('[agent-hooks] transferPaneAuthority failed:', err)
    }
  })
}
