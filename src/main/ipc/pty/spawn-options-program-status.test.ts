import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeRuntimeAuthPreparation } from '../../claude-accounts/runtime-auth/runtime-auth-types'
import { getDefaultSettings } from '../../../shared/constants'
import type { TuiAgent } from '../../../shared/tui-agent'

const applyAgentWorkspaceTrust = vi.hoisted(() =>
  vi.fn<(preset: string, path: string, context: unknown) => Promise<object>>(async () => ({}))
)
vi.mock('../../agent-workspace-trust', () => ({ applyAgentWorkspaceTrust }))

import { buildPtyIpcSpawnOptions } from './ipc/spawn-options'
import { createPtyIpcSpawnState, type PtyIpcSpawnState } from './ipc/spawn-state'
import type { AdoptStablePaneResult, PtySpawnIpcDeps } from './ipc/spawn-types'
import { buildRuntimePtySpawnOptions } from './runtime/spawn-options'
import { createRuntimePtySpawnState } from './runtime/spawn-state'
import type { PtyRuntimeControllerDeps } from './runtime/controller-deps'
import { createDaemonProgramStatusRelay } from '../../daemon/daemon-program-status-relay'
import {
  claimProgramStatusDesktopHost,
  resetProgramStatusDesktopHostForTests
} from '../../program-status/program-status-host-authority'

type BuildInput = {
  worktreeId?: string
  cwd?: string
  connectionId?: string
  launchAgent?: TuiAgent
  command?: string
  restored?: boolean
  claudeAuth?: ClaudeRuntimeAuthPreparation | null
  wslDistro?: string | null
  daemon?: boolean
}

const RESTORED_PANE: AdoptStablePaneResult = {
  result: { id: 'pty-restored' },
  owner: { tabId: 'tab-1', leafId: 'leaf-1', ptyId: 'pty-restored' }
}

function notReachedByOptionBuilding(): never {
  throw new Error('spawn option building must not call this dependency')
}

function makeDeps(): PtySpawnIpcDeps & PtyRuntimeControllerDeps {
  return {
    getSettings: () => ({ ...getDefaultSettings('/tmp'), agentWorkspaceTrustEnabled: true }),
    getLocalPtyStartupPromise: notReachedByOptionBuilding,
    getLocalPtyProviderStartupPromise: notReachedByOptionBuilding,
    adoptStablePane: notReachedByOptionBuilding,
    assertWorkspaceAcceptsNewPty: notReachedByOptionBuilding,
    resolvePtySpawnStartupCwd: notReachedByOptionBuilding,
    localStartupCwdDirectoryExists: notReachedByOptionBuilding,
    prepareCodexResumeHome: notReachedByOptionBuilding,
    noCodexResumeLaunch: notReachedByOptionBuilding,
    resolveCodexResumeLaunch: notReachedByOptionBuilding,
    reconcileSharedRuntimeResumeHome: notReachedByOptionBuilding,
    stripSequencedStartupResumeArgv: notReachedByOptionBuilding,
    transitionSpawnHiddenRendererPtyDeliveryState: notReachedByOptionBuilding,
    trustedTerminalHandleEnv: new Set(),
    sendPtySpawnedToRenderer: notReachedByOptionBuilding,
    syncPtyBackgroundedDelivery: notReachedByOptionBuilding,
    stopReplacedPty: notReachedByOptionBuilding,
    requestSerializedBuffer: notReachedByOptionBuilding,
    shutdownProviderAndDetectExit: notReachedByOptionBuilding,
    rememberSyntheticKillExit: notReachedByOptionBuilding,
    rememberRetiredRejectedPty: notReachedByOptionBuilding,
    sendPtyExitToRenderer: notReachedByOptionBuilding,
    finishPtyShutdown: notReachedByOptionBuilding,
    retiredRejectedPtyIds: new Map()
  }
}

/** What preflight and env assembly leave for the option builders; both spawn states share it. */
function seed(
  ctx: Pick<
    PtyIpcSpawnState,
    'env' | 'cwd' | 'launchCommand' | 'claudeAuth' | 'expectedWslDistro' | 'preAdoptedStablePane'
  >,
  input: BuildInput
): void {
  ctx.env = { CLAUDE_CONFIG_DIR: '/cfg' }
  ctx.cwd = input.cwd
  ctx.launchCommand = input.command
  ctx.claudeAuth = input.claudeAuth ?? null
  ctx.expectedWslDistro = input.wslDistro ?? null
  ctx.preAdoptedStablePane = input.restored ? RESTORED_PANE : null
}

async function build(route: 'renderer' | 'runtime', input: BuildInput) {
  const args = {
    cols: 80,
    rows: 24,
    worktreeId: input.worktreeId ?? 'repo-1::/repo/wt',
    connectionId: input.connectionId,
    launchAgent: input.launchAgent,
    command: input.command
  }
  if (route === 'renderer') {
    const ctx = createPtyIpcSpawnState(makeDeps(), args)
    seed(ctx, input)
    ctx.isDaemonHostSpawn = input.daemon === true
    await buildPtyIpcSpawnOptions(ctx)
    ctx.finishTerminalInstall()
    return ctx.spawnOptions
  }
  const ctx = createRuntimePtySpawnState(makeDeps(), args)
  seed(ctx, input)
  ctx.isDaemonHostSpawn = input.daemon === true
  await buildRuntimePtySpawnOptions(ctx)
  ctx.finishTerminalInstall()
  return ctx.spawnOptions
}

const platform = process.platform
const argv = process.argv
// The desktop app's main process, as its startup claims it; orcad cases undo the claim.
beforeEach(() => claimProgramStatusDesktopHost())
afterEach(() => {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  process.argv = argv
  resetProgramStatusDesktopHostForTests()
})

/** orcad's real launch: it never runs the desktop startup, so it never claims the authority. */
function asOrcad(): void {
  resetProgramStatusDesktopHostForTests()
  process.argv = [process.execPath, '/opt/orca/orcad.js', '--port', '6768', '--json']
}

function onPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value })
}

describe.each(['renderer', 'runtime'] as const)('%s spawn builder OSC 7501 ingestion', (route) => {
  it.each([
    ['a local', false],
    ['a daemon', true]
  ])('arms %s macOS PTY, plain shell or agent', async (_name, daemon) => {
    onPlatform('darwin')
    for (const input of [
      { daemon },
      { daemon, launchAgent: 'claude' as const, command: 'claude' }
    ]) {
      const options = await build(route, input)
      expect(options.startupIngress?.programStatus).toEqual({ ingest: true })
      expect(options.programStatusIngest).toBe(true)
    }
  })

  it('never arms an SSH relay PTY', async () => {
    onPlatform('darwin')
    const options = await build(route, {
      connectionId: 'ssh-1',
      launchAgent: 'codex',
      command: 'codex'
    })
    expect(options.startupIngress?.programStatus).toBeUndefined()
    expect(options.programStatusIngest).toBeUndefined()
  })

  it.each(['linux', 'win32'] as const)('leaves %s PTYs as before', async (value) => {
    onPlatform(value)
    const options = await build(route, { launchAgent: 'codex', command: 'codex' })
    expect(options.startupIngress).toBeUndefined()
    expect(options.programStatusIngest).toBeUndefined()
  })

  it('leaves headless serve unarmed', async () => {
    onPlatform('darwin')
    process.argv = [...argv, '--serve']
    const options = await build(route, {})
    expect(options.startupIngress?.programStatus).toBeUndefined()
    expect(options.programStatusIngest).toBeUndefined()
  })

  // Why its real argv: `orcad [options]` names no serve flag, so only an authority it never
  // claims keeps its PTYs, local or daemon, out of scope.
  it.each([
    ['a local', false],
    ['a daemon', true]
  ])('leaves %s PTY of the Node orcad server unarmed', async (_name, daemon) => {
    onPlatform('darwin')
    asOrcad()
    const options = await build(route, { daemon, launchAgent: 'claude', command: 'claude' })
    expect(options.startupIngress?.programStatus).toBeUndefined()
    expect(options.programStatusIngest).toBeUndefined()
    // The daemon session these options would feed tracks and relays nothing.
    const outlet = { incarnationId: 'inc-1', emit: vi.fn() }
    expect(createDaemonProgramStatusRelay(options.startupIngress, outlet)).toBeNull()
  })
})
