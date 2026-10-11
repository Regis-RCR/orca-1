import { describe, expect, it, vi } from 'vitest'
import {
  createAgentPaneAuthorityOwnership,
  createAgentPaneBindingProof
} from './agent-pane-authority-ownership'

describe('agent pane authority ownership', () => {
  it('accepts only the PTY bound to the physical local pane', () => {
    const ownsPty = createAgentPaneAuthorityOwnership({
      getPtyIdForPaneKey: (paneKey) => (paneKey === 'source-pane' ? 'pty-1' : undefined)
    })

    expect(ownsPty('source-pane', 'pty-1')).toBe(true)
    expect(ownsPty('source-pane', 'pty-forged')).toBe(false)
    expect(ownsPty('other-pane', 'pty-1')).toBe(false)
  })

  it('matches scoped and legacy runtime IDs to the authoritative terminal handle', () => {
    const getRuntimeTerminalHandleForPaneKey = vi.fn(() => 'terminal:one')
    const ownsPty = createAgentPaneAuthorityOwnership({
      getRuntimeTerminalHandleForPaneKey
    })

    expect(ownsPty('source-pane', 'remote:terminal:one')).toBe(true)
    expect(ownsPty('source-pane', 'remote:env-1@@terminal%3Aone')).toBe(true)
    expect(ownsPty('source-pane', 'remote:env-1@@other')).toBe(false)
    expect(ownsPty('source-pane', 'remote:env-1@@%E0%A4%A')).toBe(false)
    expect(ownsPty('source-pane', 'remote:@@terminal%3Aone')).toBe(false)
    expect(ownsPty('source-pane', 'remote:%20@@terminal%3Aone')).toBe(false)
    expect(ownsPty('source-pane', 'remote:env-1@@')).toBe(false)
    expect(ownsPty('source-pane', 'remote:env-1@@terminal:one')).toBe(false)
    expect(ownsPty('source-pane', 'remote:terminal%3Aone')).toBe(false)
  })

  /** Main's maps as plain records: `paneKeyPtyId`, `ptyPaneKey` and the alias table. */
  function proof(maps: {
    ptyAt: Record<string, string>
    keyOf: Record<string, string>
    alias?: Record<string, string>
  }) {
    return createAgentPaneBindingProof({
      getPtyIdForPaneKey: (paneKey) => maps.ptyAt[paneKey],
      getPaneKeyForPty: (ptyId) => maps.keyOf[ptyId],
      resolvePaneKeyAlias: (paneKey) => maps.alias?.[paneKey] ?? paneKey
    })
  }

  it('binds a pane only when all three conjuncts hold, each refusing on its own', () => {
    const bound = { ptyAt: { P: 'x' }, keyOf: { x: 'P' } }
    expect(proof(bound)('P', 'x')).toBe(true)
    // 1: the PTY no longer holds its own spawn key (P rebound to a live y).
    expect(proof({ ptyAt: { P: 'y' }, keyOf: { x: 'P', y: 'P' } })('P', 'x')).toBe(false)
    expect(proof({ ptyAt: {}, keyOf: {} })('P', 'x')).toBe(false)
    const reused = { ptyAt: { from: 'y' }, keyOf: { x: 'from', y: 'from' }, alias: { from: 'to' } }
    expect(proof(reused)('to', 'x')).toBe(false)
    // 2: the spawn key is not alias-equal to the named pane.
    expect(proof({ ptyAt: { P: 'x', Q: 'y' }, keyOf: { x: 'P' } })('Q', 'x')).toBe(false)
    // 3: another PTY holds the canonical target although the spawn key resolves there.
    const moved = {
      ptyAt: { from: 'x', to: 'y' },
      keyOf: { x: 'from', y: 'to' },
      alias: { from: 'to' }
    }
    expect(proof(moved)('to', 'x')).toBe(false)
    expect(proof({ ...moved, ptyAt: { from: 'x' } })('to', 'x')).toBe(true)
  })

  it('keeps the remote runtime-handle branch as the alternative', () => {
    const bindsPane = createAgentPaneBindingProof({
      getRuntimeTerminalHandleForPaneKey: () => 'terminal:one',
      resolvePaneKeyAlias: (paneKey) => paneKey
    })
    expect(bindsPane('P', 'remote:env-1@@terminal%3Aone')).toBe(true)
    expect(bindsPane('P', 'pty-local')).toBe(false)
  })
})
