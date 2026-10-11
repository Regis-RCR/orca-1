import { beforeEach, expect, it, vi } from 'vitest'
import { createWorkerMaintenanceFixture } from '../persistence/loading-store/profile-state-maintenance-fixture'

const { handleMock, applyAgentStatusHooksEnabledMock } = vi.hoisted(() => ({
  handleMock: vi.fn(),
  applyAgentStatusHooksEnabledMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/test/user-data') },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  ipcMain: { handle: handleMock, on: vi.fn() },
  nativeTheme: { themeSource: 'system' }
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({
  getCohortAtEmit: () => ({ nth_repo_added: 2 })
}))
vi.mock('../ssh/ssh-config-parser', () => ({
  loadUserSshConfig: () => ({ hosts: [] }),
  sshConfigHostsToTargets: () => []
}))
vi.mock('../ghostty/index', () => ({ previewGhosttyImport: vi.fn() }))
vi.mock('../warp-themes', () => ({ previewWarpThemeImport: vi.fn() }))
vi.mock('../network/proxy-settings', () => ({
  applyElectronProxySettings: vi.fn().mockResolvedValue({ source: 'settings' })
}))
vi.mock('../browser/browser-session-proxy', () => ({
  applyBrowserSessionProxies: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../browser/browser-session-registry', () => ({
  browserSessionRegistry: { listProfiles: vi.fn(() => []) }
}))
vi.mock('../app-icon', () => ({ applyAppIcon: vi.fn() }))
vi.mock('../ai-vault-search/session-search-enablement', () => ({
  applySessionSearchSettingsChange: vi.fn()
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  applyAgentStatusHooksEnabled: applyAgentStatusHooksEnabledMock
}))
vi.mock('../worktree-root-preparation', () => ({
  prepareLocalWorktreeRootsForRepos: vi.fn().mockResolvedValue(undefined)
}))
vi.mock('../menu/register-app-menu', () => ({ rebuildAppMenu: vi.fn() }))
vi.mock('../tray/system-tray', () => ({ rebuildSystemTrayMenu: vi.fn() }))
vi.mock('../i18n/main-i18n', () => ({ setMainUiLanguage: vi.fn().mockResolvedValue('en') }))

import { registerSettingsHandlers } from './settings'

beforeEach(() => {
  handleMock.mockClear()
  applyAgentStatusHooksEnabledMock.mockReset().mockResolvedValue([])
})

it('stores the OSC 7501 preference as a strict boolean without reconciling hooks', async () => {
  const { store } = await createWorkerMaintenanceFixture()
  store.updateSettings({ agentStatusHooksEnabled: true, agentProgramStatusPreferred: false })
  await store.flushPendingOrThrowAsync()
  const updateSettings = vi.spyOn(store, 'updateSettings')
  registerSettingsHandlers(store)
  const handler = handleMock.mock.calls.find((call) => call[0] === 'settings:set')?.[1]
  for (const [sent, stored] of [
    ['yes', false],
    [true, true]
  ] as const) {
    await handler({ sender: { id: 1 } }, { agentProgramStatusPreferred: sent })
    const [updates] = updateSettings.mock.lastCall ?? []
    expect(updates).toEqual({ agentProgramStatusPreferred: stored })
    expect(store.getSettings().agentProgramStatusPreferred).toBe(stored)
  }
  expect(applyAgentStatusHooksEnabledMock).not.toHaveBeenCalled()
})
