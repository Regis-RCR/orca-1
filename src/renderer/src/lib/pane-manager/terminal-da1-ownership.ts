import type { IDisposable } from '@xterm/xterm'

const owners = new WeakMap<object, { refresh: () => void }>()

/** Keep Orca's replay-aware DA1 responder after subsequently attached addons. */
export function registerTerminalDa1Owner(
  terminal: object,
  register: () => IDisposable
): IDisposable {
  let handler = register()
  const owner = {
    refresh: () => {
      handler.dispose()
      handler = register()
    }
  }
  owners.set(terminal, owner)
  return {
    dispose: () => {
      handler.dispose()
      if (owners.get(terminal) === owner) {
        owners.delete(terminal)
      }
    }
  }
}

export function refreshTerminalDa1Owner(terminal: object): void {
  owners.get(terminal)?.refresh()
}
