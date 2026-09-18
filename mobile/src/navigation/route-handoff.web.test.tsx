import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_PROTOCOL_VERSION } from '../mobile-web-shell/bridge/bridge-envelope'
import { createShellPageClient } from '../mobile-web-shell/bridge/page-bootstrap'
import type { BridgeRpcClient } from '../mobile-web-shell/bridge/bridge-rpc-client'
import type { RouteHandoff } from './route-handoff'

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  dismissTo: vi.fn(),
  back: vi.fn()
}))

vi.mock('expo-router', () => ({ useRouter: () => router }))
// The web file re-exports the screen hooks through the provider module, and reaching the real ones
// imports the Expo runtime this test does not have. Nothing below calls one.
vi.mock('../transport/host-client-hooks', () => ({
  useDisconnectHostClient: () => () => {},
  useForceReconnect: () => () => Promise.resolve(),
  useForgetHostClient: () => () => {},
  useHostClient: () => ({ client: null, clientId: null, state: 'disconnected' }),
  usePrimeHosts: () => () => {},
  useRefreshHostClient: () => () => {}
}))

import { RpcClientProvider } from '../transport/client-context.web'
import { useRouteHandoff } from './route-handoff.web'

const INIT = {
  v: BRIDGE_PROTOCOL_VERSION,
  type: 'init',
  sessionId: 'session-a',
  buildId: 'build-a',
  connection: {
    state: 'connected',
    reconnectAttempt: 0,
    lastConnectedAt: 1,
    lastInboundAt: 1,
    generation: 0
  },
  grants: { rpc: { maxPendingRequests: 64, maxSubscriptions: 32 }, native: ['navigate'] },
  route: { pathname: '/h/host-a' },
  pageRoutes: ['/h/[hostId]']
}

const held: { handoff: RouteHandoff | null } = { handoff: null }

function Screen(): null {
  held.handoff = useRouteHandoff()
  return null
}

function installChannel(): { posted: string[]; deliver: (frame: unknown) => void } {
  const posted: string[] = []
  const channel: {
    postMessage: (json: string) => void
    onmessage: ((event: { data: string }) => void) | null
  } = {
    postMessage: (json) => {
      posted.push(json)
    },
    onmessage: null
  }
  Object.defineProperty(globalThis, 'orcaBridge', { value: channel, configurable: true })
  return {
    posted,
    deliver: (frame) => {
      channel.onmessage?.({ data: JSON.stringify(frame) })
    }
  }
}

/** The page as the entry leaves it: one client, already holding a session. */
function mount(init: unknown): { posted: string[]; handoff: RouteHandoff } {
  const channel = installChannel()
  const client = createShellPageClient()
  if (client === null) {
    throw new Error('no channel installed')
  }
  channel.deliver(init)
  act(() => {
    create(render(client))
  })
  const handoff = held.handoff
  if (handoff === null) {
    throw new Error('no screen mounted')
  }
  return { posted: channel.posted, handoff }
}

function render(client: BridgeRpcClient): ReactElement {
  return (
    <RpcClientProvider client={client}>
      <Screen />
    </RpcClientProvider>
  )
}

function navigations(posted: readonly string[]): unknown[] {
  return posted
    .map((json) => JSON.parse(json))
    .filter((frame: { name?: string }) => frame.name === 'navigate')
}

beforeEach(() => {
  vi.useFakeTimers()
  held.handoff = null
  router.push.mockClear()
  router.replace.mockClear()
  router.dismissTo.mockClear()
  router.back.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
  Reflect.deleteProperty(globalThis, 'orcaBridge')
})

describe('a route the page does not render', () => {
  it('goes to the shell, and nowhere inside this document', () => {
    const { posted, handoff } = mount(INIT)
    handoff.push('/h/host-a/session/wt-1?name=a+b')
    expect(navigations(posted)).toEqual([
      {
        v: BRIDGE_PROTOCOL_VERSION,
        type: 'notify',
        name: 'navigate',
        href: '/h/host-a/session/wt-1?name=a+b'
      }
    ])
    expect(router.push).not.toHaveBeenCalled()
  })

  it('goes to the shell on a replace too, because the shell only knows how to push', () => {
    const { posted, handoff } = mount(INIT)
    handoff.replace('/h/host-a/tasks')
    expect(navigations(posted)).toHaveLength(1)
    expect(router.replace).not.toHaveBeenCalled()
  })

  it('reads the path and not the query, so a target with params is still matched', () => {
    const { posted, handoff } = mount(INIT)
    handoff.push('/h/host-b?from=list')
    // `/h/host-b` is a page route; the query is not part of what the pattern matches.
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith('/h/host-b?from=list')
  })
})

describe('a route the page does render', () => {
  it('stays in this document rather than re-entering the shell for it', () => {
    const { posted, handoff } = mount(INIT)
    handoff.push('/h/host-b')
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith('/h/host-b')
  })

  it('replaces locally, which is a history entry the native stack never had', () => {
    const { handoff } = mount(INIT)
    handoff.replace('/h/host-b')
    expect(router.replace).toHaveBeenCalledWith('/h/host-b')
  })
})

describe('the members that stay inside this document', () => {
  it('are the router own members, untouched', () => {
    const { handoff } = mount(INIT)
    handoff.back()
    expect(router.back).toHaveBeenCalled()
  })

  it('hand the way out of the host over, since home is a native route', () => {
    const { posted, handoff } = mount(INIT)
    handoff.dismissTo('/')
    expect(navigations(posted)).toEqual([
      { v: BRIDGE_PROTOCOL_VERSION, type: 'notify', name: 'navigate', href: '/' }
    ])
    expect(router.dismissTo).not.toHaveBeenCalled()
  })
})

describe('a shell that granted no navigate', () => {
  it('falls through to this document rather than doing nothing at all', () => {
    // Unmatched is a worse screen than the one the page is on, and a tap that does nothing is
    // worse than both. The route policy is what keeps this case off a device: a shell with no
    // `navigate` renders no page route in the first place.
    const { posted, handoff } = mount({
      ...INIT,
      grants: { ...INIT.grants, native: [] },
      pageRoutes: []
    })
    handoff.push('/h/host-a/tasks')
    expect(navigations(posted)).toEqual([])
    expect(router.push).toHaveBeenCalledWith('/h/host-a/tasks')
  })
})
