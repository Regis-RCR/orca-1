import { useMemo } from 'react'
import { useRouter } from 'expo-router'
import { matchesRoutePattern } from '../mobile-web-shell/page-route-policy'
import { usePageBridgeClient } from '../transport/client-context.web'
import type { RouteHandoff } from './route-handoff'

/** The path half of a target, which is what the shell's route patterns are written against. */
function pathnameOf(href: string): string {
  const cut = href.search(/[?#]/)
  return cut === -1 ? href : href.slice(0, cut)
}

/**
 * Web sibling: a route the page renders it takes, and a route it does not it hands back.
 *
 * The page is one document standing in for one screen. Pushing a screen it does not carry would
 * paint expo-router's Unmatched, and re-entering the shell for it would re-execute a multi-megabyte
 * bundle on every tap, so the shell pushes the native screen over the still-mounted view instead
 * and Back reveals the page with nothing reloaded.
 *
 * The three members that leave this document are wrapped and the rest are the router's own: the
 * shell says which routes are the page's, in `init`, and the same answer drives all three. A
 * handoff the shell cannot honour — an older shell that granted no `navigate` — falls through to
 * the local router: Unmatched is a worse screen than the one the page is on, but a tap that does
 * nothing at all is worse than both, and the route policy is what keeps that case off a device.
 */
export function useRouteHandoff(): RouteHandoff {
  const client = usePageBridgeClient()
  const router = useRouter()

  return useMemo<RouteHandoff>(() => {
    const handOff = (href: string): boolean => {
      const pathname = pathnameOf(href)
      const pageRoutes = client.getShellSession()?.pageRoutes ?? []
      if (pageRoutes.some((pattern) => matchesRoutePattern(pathname, pattern))) {
        return false
      }
      return client.notifyNavigate(href)
    }
    return {
      ...router,
      push: (href) => {
        if (!handOff(String(href))) {
          router.push(href)
        }
      },
      // The shell has one way to open a screen and it is a push, so a replace the page cannot keep
      // becomes one too. What it replaces is a history entry inside this document, which the native
      // stack never had; leaving it is what lets Back come back to the page.
      replace: (href) => {
        if (!handOff(String(href))) {
          router.replace(href)
        }
      },
      // The list's own way out of the host. Inside the page there is no stack to pop to: the phone's
      // home screen is a native route, so it is handed over like any other.
      dismissTo: (href) => {
        if (!handOff(String(href))) {
          router.dismissTo(href)
        }
      }
    }
  }, [client, router])
}
