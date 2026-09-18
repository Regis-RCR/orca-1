// Route A web entry: mounts the phone's h/[hostId] route tree on react-native-web.
// Dark: built by `build:mobile-web:app` into out/mobile-web-app, shipped by nothing until C1.
import { useEffect, type PropsWithChildren } from 'react'
import { createRoot } from 'react-dom/client'
import { ExpoRoot } from 'expo-router'
import type { BridgeRpcClient } from '../src/mobile-web-shell/bridge/bridge-rpc-client'
import {
  bootstrapShellPage,
  createShellPageClient,
  stampPageMountState,
  type PageMountTarget
} from '../src/mobile-web-shell/bridge/page-bootstrap'
// Named with its extension: this entry is the web build's and the provider it needs is the web
// sibling's, which takes the page's client. The screens below still import `./client-context`
// and reach the same module, because the builder resolves both specifiers to the same file.
import { RpcClientProvider } from '../src/transport/client-context.web'
// Body replaced at build time: esbuild has no require.context, so the builder synthesizes one.
import routeContext from './route-manifest'

// The route tree starts at app/h, below the native root layout that owns the provider, so the
// page supplies it here through ExpoRoot's own wrapper rather than mounting the native shell.
// A factory because the client is not in scope until `init` lands, and ExpoRoot takes a component.
function createRootProviders(client: BridgeRpcClient, target: PageMountTarget) {
  return function RootProviders({ children }: PropsWithChildren) {
    // Effects run child-first, so 'mounted' lands only after the router tree below this wrapper
    // has committed. The tree is rendered once, with a ready client, so there is one such commit.
    useEffect(() => {
      stampPageMountState(target, 'mounted')
    }, [])
    return <RpcClientProvider client={client}>{children}</RpcClientProvider>
  }
}

const container = document.getElementById('root')
if (!container) {
  throw new Error('[orca-mobile-web-app] #root missing')
}
const target = document.documentElement
stampPageMountState(target, 'started')

bootstrapShellPage({
  target,
  client: createShellPageClient(),
  mount: (client) => {
    createRoot(container).render(
      <ExpoRoot context={routeContext} wrapper={createRootProviders(client, target)} />
    )
  }
})
