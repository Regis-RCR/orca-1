import type { ImageAddon, IImageAddonOptions } from '@xterm/addon-image'

// Why deferred: @xterm/addon-image ships the SIXEL/QOI/base64 wasm decoders
// inlined as base64 plus the protocol handlers — a chunk no idle terminal needs.
// Panes only ever construct it once a terminal attaches with inline images
// enabled. Later panes reuse the loaded constructor synchronously.
type ImageAddonConstructor = new (options?: IImageAddonOptions) => ImageAddon

let imageAddonConstructor: ImageAddonConstructor | null = null
let imageAddonLoad: Promise<void> | null = null
let imageAddonLoadAttempts = 0

// Why a cap: a genuinely missing chunk (bad deploy, unreadable disk) must not
// re-fetch on every pane open, but one transient failure must not disable inline
// images for the whole session either.
const IMAGE_ADDON_LOAD_ATTEMPT_LIMIT = 3

type TerminalImageAddonLoadHandlers = {
  /** Attach the panes that opened while the load was still in flight. */
  onLoaded: () => void
}

let handlers: TerminalImageAddonLoadHandlers | null = null

export function setTerminalImageAddonLoadHandlers(next: TerminalImageAddonLoadHandlers): void {
  handlers = next
}

export function getTerminalImageAddonConstructor(): ImageAddonConstructor | null {
  return imageAddonConstructor
}

export function primeTerminalImageAddon(): Promise<void> {
  if (imageAddonConstructor || imageAddonLoad) {
    return imageAddonLoad ?? Promise.resolve()
  }
  if (imageAddonLoadAttempts >= IMAGE_ADDON_LOAD_ATTEMPT_LIMIT) {
    return Promise.resolve()
  }
  imageAddonLoadAttempts += 1
  imageAddonLoad = import('@xterm/addon-image').then(
    (module) => {
      imageAddonConstructor = module.ImageAddon
      handlers?.onLoaded()
    },
    (error) => {
      // Why clear the memo: `.then(onOk, onError)` settles *fulfilled*, so
      // caching it would strand inline images off for the rest of the session
      // even though a later pane open could retry within the attempt cap.
      imageAddonLoad = null
      console.warn('[terminal] image addon failed to load — inline images disabled:', error)
    }
  )
  return imageAddonLoad
}
