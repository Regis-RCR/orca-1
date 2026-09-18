import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState, RpcResponse } from '../transport/types'
import { BridgeHostRequests } from './bridge-host-requests'
import { BridgeHostSubscriptions } from './bridge-host-subscriptions'
import { MOBILE_WEB_SHELL_GRANTS } from './page-route-policy'
import {
  BRIDGE_MAX_PENDING_REQUESTS,
  BRIDGE_MAX_SUBSCRIPTIONS,
  type BridgeRefusal
} from './bridge/bridge-caps'
import {
  BRIDGE_PROTOCOL_VERSION,
  readBridgeClientMessage,
  type BridgeClientMessage,
  type BridgeConnectionSnapshot,
  type BridgeHostMessage,
  type BridgeInitHost,
  type BridgeInitRoute
} from './bridge/bridge-envelope'
import { captureBridgeError } from './bridge/bridge-error-capture'
import { splitBridgeReply } from './bridge/bridge-reply-chunking'

type SubscribeMessage = Extract<BridgeClientMessage, { type: 'subscribe' }>
type NotifyMessage = Extract<BridgeClientMessage, { type: 'notify' }>

/** Nothing here is recoverable in place; each is worth a line in a log and none of them is retried. */
export type BridgeHostDiagnostic =
  | { kind: 'refused'; refusal: BridgeRefusal }
  | { kind: 'post-failed'; error: unknown }
  /** A page posting into a host that has already been disposed, which its own view is the only
   *  thing that can do. Dropping it silently is what hides a leaked view. */
  | { kind: 'frame-after-dispose' }
  /** A client that threw where the bridge only forwards. Nothing is owed to the page for a notify,
   *  so the throw is reported rather than answered. */
  | { kind: 'notify-failed'; error: unknown }
  /** A frame that arrived between a page's `close` and the next document's `ready`. It belongs to
   *  the closed document, and serving it would answer into whatever loads in next. */
  | { kind: 'frame-after-close' }

export type BridgeHostOptions = {
  client: RpcClient
  /**
   * Rejects when there is nowhere to post. Resolving proves the message was handed over, never that
   * the page received it, so nothing here treats a resolve as an acknowledgement.
   */
  post: (json: string) => Promise<void>
  buildId: string
  sessionId: string
  /**
   * Which screen the page should open. Required of a caller in this build and optional on the wire:
   * an older shell sends no route at all, and the page has a state for that which nothing here can
   * reach.
   */
  route: BridgeInitRoute
  /** Every route pattern the shell would render from the page, so the page knows what to keep. */
  pageRoutes: readonly string[]
  /** The host the page is showing, minus the credential the bridge already carries for it. */
  host: BridgeInitHost
  /** The allowlisted keys as the app holds them, which is the page's whole read side. */
  storage: Readonly<Record<string, string>>
  /** One allowlisted key written, or removed when the value is null. */
  onStorageWrite: (key: string, value: string | null) => void
  /**
   * Opens a screen the page does not render. Required, because `init` grants `navigate` on the
   * strength of this existing: a page told it may hand a route back and then handed one back into
   * nothing is a dead tap, which is exactly what the grant is supposed to rule out.
   */
  onNavigate: (href: string) => void
  onDiagnostic?: (diagnostic: BridgeHostDiagnostic) => void
}

export type BridgeHost = {
  receive: (json: string) => void
  dispose: () => void
}

class BridgeCapExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BridgeCapExceededError'
  }
}

class BridgeReplyUndeliverableError extends Error {
  constructor(refusal: BridgeRefusal) {
    super(`the reply could not be delivered to the page (${refusal})`)
    this.name = 'BridgeReplyUndeliverableError'
  }
}

/**
 * One page document's end of the bridge: page frames in, host frames out, one RPC client behind it.
 *
 * The fence is structural rather than checked. The protocol names no host, so a page cannot ask for
 * one: the client is whichever this host was built with, and a page that outlives its session has
 * its frames refused at the native origin check before this module ever sees them. The caps the
 * page is told about in `init` are enforced here and not trusted from there.
 */
export function createBridgeHost(options: BridgeHostOptions): BridgeHost {
  const { client, buildId, sessionId, route, pageRoutes, host, storage } = options
  let closed = false
  // One document's turn at the bridge. `close` ends it and the next `ready` begins the next one;
  // between the two the view belongs to no document, so nothing is served and nothing is posted.
  // No epoch rides along: one native listener delivers page frames in order, so a straggler from
  // the closed document is always behind it and ahead of the next document's `ready`.
  let serving = true
  let postFailureReported = false
  let notifyFailureReported = false

  // Once per session: a page that cannot be posted to fails every frame after the first, and a
  // line per frame buries the one that says why.
  function reportPostFailure(error: unknown): void {
    if (postFailureReported) {
      return
    }
    postFailureReported = true
    options.onDiagnostic?.({ kind: 'post-failed', error })
  }

  function sendJson(json: string): void {
    // Defensive: teardown already settles everything that could post; this fences callers added later.
    if (closed) {
      return
    }
    // Between documents the view still exists and still accepts posts, which is exactly why this is
    // checked: a `state` frame sent now lands in the next document before it has said `ready`.
    if (!serving) {
      return
    }
    // A `post` that throws where it should reject would escape into the client's own state-change
    // fan-out, which is what sends the `state` frame, and take the other listeners down with it.
    try {
      void options.post(json).catch(reportPostFailure)
    } catch (error) {
      reportPostFailure(error)
    }
  }

  // Every value in a host frame has already been serialized by whoever produced it — a reply by
  // `splitBridgeReply`, an error `code` by the capture's round trip — so this cannot throw.
  function send(frame: BridgeHostMessage): void {
    sendJson(JSON.stringify(frame))
  }

  function sendError(id: string, error: unknown): void {
    send({ v: BRIDGE_PROTOCOL_VERSION, type: 'error', id, error: captureBridgeError(error) })
  }

  const subscriptions = new BridgeHostSubscriptions({ client, post: sendJson })

  /** `state` is the event's own value: a listener can run before the getter it mirrors is updated. */
  function snapshot(state?: ConnectionState): BridgeConnectionSnapshot {
    return {
      state: state ?? client.getState(),
      reconnectAttempt: client.getReconnectAttempt(),
      lastConnectedAt: client.getLastConnectedAt(),
      lastInboundAt: client.getLastInboundAt?.() ?? null,
      generation: client.getGeneration?.() ?? null
    }
  }

  // Answered every time it is asked: a page that saw a `state` older than the one it holds recovers
  // by asking again rather than by living with a cache it knows is wrong.
  function sendInit(): void {
    send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: 'init',
      sessionId,
      buildId,
      connection: snapshot(),
      grants: {
        rpc: {
          maxPendingRequests: BRIDGE_MAX_PENDING_REQUESTS,
          maxSubscriptions: BRIDGE_MAX_SUBSCRIPTIONS
        },
        // What this shell will do on the page's behalf, and it is what makes the page's `navigate`
        // frame something other than a frame this side refuses. A name added here is never a
        // version bump; a page that does not know one simply never posts it.
        native: [...MOBILE_WEB_SHELL_GRANTS]
      },
      route,
      pageRoutes: [...pageRoutes],
      host,
      storage: { ...storage }
    })
  }

  function sendReply(id: string, payload: RpcResponse): void {
    const split = splitBridgeReply(id, payload)
    if (!split.ok) {
      sendError(id, new BridgeReplyUndeliverableError(split.refusal))
      return
    }
    for (const frame of split.frames) {
      send(frame)
    }
  }

  const requests = new BridgeHostRequests({
    client,
    isIdTaken: (id) => subscriptions.has(id),
    sendReply,
    sendError,
    capExceeded: (message) => new BridgeCapExceededError(message)
  })

  // `wantsBinary` is read by the contract and acted on in C6, which owns the screencast encoder and
  // the measurement that earns it. Until then every stream crosses as JSON.
  function handleSubscribe(message: SubscribeMessage): void {
    const { id } = message
    if (requests.has(id) || subscriptions.has(id)) {
      sendError(id, new BridgeCapExceededError('that id is already in flight'))
      return
    }
    if (subscriptions.size >= BRIDGE_MAX_SUBSCRIPTIONS) {
      sendError(id, new BridgeCapExceededError(`over ${BRIDGE_MAX_SUBSCRIPTIONS} subscriptions`))
      return
    }
    try {
      subscriptions.start(id, message.method, message.params)
    } catch (error) {
      sendError(id, error)
    }
  }

  /** The client's own work runs inside these calls, and a throw from one would otherwise escape into
   *  the native event handler that delivered the page's frame. Nothing is owed to the page here. */
  function forwardNotify(message: NotifyMessage): void {
    try {
      if (message.name === 'foreground') {
        if (message.reason === undefined) {
          client.notifyForeground()
        } else {
          client.notifyForeground(message.reason)
        }
        return
      }
      if (message.name === 'navigate') {
        // Not routed to the client: this one never leaves the phone. The page asked for a screen
        // it does not render, and the caller pushes it over the still-mounted view.
        options.onNavigate(message.href)
        return
      }
      if (message.name === 'storage') {
        // Also local. The key is allowlisted by the envelope before this runs, so what reaches the
        // app's store is one of the few the page was ever told about.
        options.onStorageWrite(message.key, message.value)
        return
      }
      client.updateTerminalSubscriptionViewport(message.terminal, {
        cols: message.cols,
        rows: message.rows
      })
    } catch (error) {
      // Once per session, for the reason a failing post is: a page nudging a broken client nudges it
      // again on every foreground.
      if (notifyFailureReported) {
        return
      }
      notifyFailureReported = true
      options.onDiagnostic?.({ kind: 'notify-failed', error })
    }
  }

  /** Cancels everything the page had open. `notify` is false for the page's own `close`, which has
   *  already settled what it owned. */
  function settleAll(notify: boolean): void {
    requests.closeAll(notify)
    subscriptions.closeAll(notify ? 'closed' : null)
  }

  function dispose(): void {
    if (closed) {
      return
    }
    settleAll(true)
    closed = true
    unsubscribeState()
  }

  function dispatch(message: BridgeClientMessage): void {
    // `ready` is what claims the view, whether it is the first document's or a replacement's; a
    // re-asked `ready` from the document already being served is answered the same way.
    if (message.type === 'ready') {
      serving = true
      sendInit()
      return
    }
    if (!serving) {
      options.onDiagnostic?.({ kind: 'frame-after-close' })
      return
    }
    switch (message.type) {
      case 'request':
        requests.open(message)
        return
      case 'subscribe':
        handleSubscribe(message)
        return
      case 'cancel': {
        if (message.target === 'subscription') {
          subscriptions.cancel(message.id, 'unsubscribed')
          return
        }
        requests.cancel(message.id)
        return
      }
      case 'ack':
        subscriptions.ack(message.id, message.seq)
        return
      case 'notify':
        forwardNotify(message)
        return
      case 'close':
        // Not a latch. The document that loads next into this same view says `ready` over this same
        // host, and a host that had shut itself would leave that `ready` retrying forever.
        settleAll(false)
        serving = false
        return
    }
  }

  const unsubscribeState = client.onStateChange((state) => {
    send({ v: BRIDGE_PROTOCOL_VERSION, type: 'state', connection: snapshot(state) })
  })

  return {
    receive(json: string): void {
      if (closed) {
        // Only a disposed host reaches this, and it can neither answer the frame nor refuse it.
        options.onDiagnostic?.({ kind: 'frame-after-dispose' })
        return
      }
      const read = readBridgeClientMessage(json)
      if (!read.ok) {
        options.onDiagnostic?.({ kind: 'refused', refusal: read.refusal })
        return
      }
      dispatch(read.message)
    },
    dispose
  }
}
