import { useEffect, useState } from 'react'
import AsyncStorage from '@react-native-async-storage/async-storage'
import { loadHosts } from '../transport/host-store'
import type { BridgeInitHost } from './bridge/bridge-envelope'
import { isPageStorageKey, pageStorageKeysForHost } from './page-storage-keys'

export type PageHostSnapshot = {
  host: BridgeInitHost
  /** Only the keys that exist; an absent key is absent, never an empty string. */
  storage: Readonly<Record<string, string>>
}

/**
 * What the page cannot read for itself: this host, and the few stored keys its screens keep.
 *
 * `expo-secure-store` is `{}` on web and AsyncStorage's web build is `window.localStorage`, which
 * the page has none of — Android turns DOM storage off and on iOS the origin is the session id, so
 * a page-side write is gone on the next remount. Both cross in `init` instead, which is also why
 * this is read before the bridge host is built rather than after: `init` is answered once per
 * `ready` and the page re-asks until it lands, so a host built without this would have to be torn
 * down to carry it.
 *
 * Null until both reads settle. A profile that is simply not there stays null: the page would show
 * "Host not found" over a host the shell just opened, which is the bug this exists to fix.
 */
export function usePageHostSnapshot(hostId: string): PageHostSnapshot | null {
  const [snapshot, setSnapshot] = useState<PageHostSnapshot | null>(null)

  useEffect(() => {
    let stale = false
    setSnapshot(null)
    const read = async (): Promise<PageHostSnapshot | null> => {
      const hosts = await loadHosts()
      const found = hosts.find((profile) => profile.id === hostId)
      if (!found) {
        return null
      }
      const pairs = await AsyncStorage.multiGet(pageStorageKeysForHost(hostId))
      const storage: Record<string, string> = {}
      for (const [key, value] of pairs) {
        // Checked again here rather than trusted from the key list: this is the value the page is
        // handed, and the allowlist is the one thing standing between it and the app's namespace.
        if (value !== null && isPageStorageKey(key)) {
          storage[key] = value
        }
      }
      return {
        host: {
          id: found.id,
          name: found.name,
          endpoint: found.endpoint,
          lastConnected: found.lastConnected
        },
        storage
      }
    }
    void read().then(
      (next) => {
        if (!stale) {
          setSnapshot(next)
        }
      },
      () => {
        // A keychain read that failed is not a host that is gone; the page waits rather than
        // mounting a list that would name the wrong thing.
      }
    )
    return () => {
      stale = true
    }
  }, [hostId])

  return snapshot
}

/** The page's writes, applied to the app's own store. Allowlisted by the envelope before it lands. */
export function writePageStorage(key: string, value: string | null): void {
  void (value === null ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, value)).catch(
    () => {
      // Nothing is owed to the page for a notify, and a pin that failed to persist is not a reason
      // to take the workspace off screen.
    }
  )
}
