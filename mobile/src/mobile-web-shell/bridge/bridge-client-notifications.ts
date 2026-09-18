import type { ForegroundNudgeReason } from '../../transport/types'
import { BRIDGE_PROTOCOL_VERSION, type BridgeClientMessage } from './bridge-envelope'

/**
 * Everything the page posts and hears nothing back about.
 *
 * All three share one guard, and it is not the same guard `sendRequest` uses. A call before `init`
 * is a mount-order bug and throws; a call after `close` is an unmounting screen posting one more
 * nudge on its way out, which the native clients answer inertly rather than by throwing into a
 * teardown path nobody wrote a catch for. Nothing here returns a promise, so nothing here can be
 * awaited into a rejection either.
 */
export type BridgeClientNotificationDeps = {
  /** False when the frame never left the page. */
  send: (frame: BridgeClientMessage) => boolean
  /** Throws when `init` has not landed. */
  requireSession: () => void
  isClosed: () => boolean
  /** What `init.grants.native` named. A grant the shell did not give is a frame it would refuse. */
  hasGrant: (name: string) => boolean
}

export type BridgeClientNotifications = {
  updateTerminalSubscriptionViewport: (
    terminal: string,
    viewport: { cols: number; rows: number }
  ) => void
  notifyForeground: (reason?: ForegroundNudgeReason) => void
  notifyNavigate: (href: string) => boolean
}

export function createBridgeClientNotifications(
  deps: BridgeClientNotificationDeps
): BridgeClientNotifications {
  function post(frame: BridgeClientMessage): boolean {
    deps.requireSession()
    return deps.isClosed() ? false : deps.send(frame)
  }

  return {
    updateTerminalSubscriptionViewport: (terminal, viewport) => {
      post({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'terminalViewport',
        terminal,
        cols: viewport.cols,
        rows: viewport.rows
      })
    },
    notifyForeground: (reason) => {
      post({
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'foreground',
        ...(reason === undefined ? {} : { reason })
      })
    },
    // The one that answers: `notify` is closed, so a shell that granted no `navigate` would refuse
    // the whole frame, and a tap handler needs to know that before it decides it has navigated.
    notifyNavigate: (href) =>
      deps.hasGrant('navigate') &&
      post({ v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'navigate', href })
  }
}
