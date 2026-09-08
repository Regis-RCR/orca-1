import type { ManagedPaneInternal } from '../../lib/pane-manager/pane-manager-types'
import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/xterm'

describe('inline image DA1 ownership', () => {
  it.each(['primed', 'deferred'] as const)(
    'preserves Orca replies and replay suppression with a %s real image addon',
    async (loading) => {
      vi.resetModules()
      const { installTerminalCapabilityReplyHandlers } =
        await import('./terminal-capability-replies')
      const { attachInlineImages, detachInlineImages } =
        await import('../../lib/pane-manager/pane-inline-images')
      const { primeTerminalImageAddon } =
        await import('../../lib/pane-manager/terminal-image-addon-loader')
      const terminal = new Terminal({ allowProposedApi: true })
      const pane = {
        id: 1,
        terminal,
        imageAddon: null,
        imageAttachmentDeferred: false
      } as unknown as ManagedPaneInternal
      const replies: string[] = []
      let replaying = false
      let enabled = true
      terminal.onData((data) => replies.push(data))
      if (loading === 'primed') {
        await primeTerminalImageAddon()
        attachInlineImages(pane)
      }
      const owner = installTerminalCapabilityReplyHandlers({
        terminal,
        parser: terminal.parser,
        sendInput: (data) => {
          replies.push(data)
        },
        isReplaying: () => replaying,
        sixelSupported: () => enabled
      })
      try {
        if (loading === 'deferred') {
          attachInlineImages(pane)
          expect(pane.imageAttachmentDeferred).toBe(true)
          await primeTerminalImageAddon()
        }
        expect(pane.imageAddon).not.toBeNull()
        const query = () => new Promise<void>((resolve) => terminal.write('\x1b[c', resolve))
        await query()
        expect(replies.splice(0)).toEqual(['\x1b[?1;2;4c'])
        replaying = true
        await query()
        expect(replies).toEqual([])
        replaying = false
        enabled = false
        detachInlineImages(pane)
        await query()
        expect(replies.splice(0)).toEqual(['\x1b[?1;2c'])
        enabled = true
        attachInlineImages(pane)
        await query()
        expect(replies.splice(0)).toEqual(['\x1b[?1;2;4c'])
      } finally {
        detachInlineImages(pane)
        owner.dispose()
        terminal.dispose()
      }
    }
  )
})
