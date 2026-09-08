import type { IImageAddonOptions } from '@xterm/addon-image'

// Per-sequence byte ceiling for every protocol. Bounds the decoder's working
// buffer so one oversized paste cannot stall the parser or balloon memory; 8 MB
// of encoded data still covers any reasonable inline image.
const IMAGE_SEQUENCE_SIZE_LIMIT = 8 * 1024 * 1024

// Per-pane decoded-image cache before FIFO eviction (MB of RGBA). Kept well
// below the addon's 128 MB default so many open panes cannot collectively pin
// hundreds of MB of bitmaps.
const IMAGE_STORAGE_LIMIT_MB = 32

/** Addon options tuned for Orca: reuse Orca's own size-report + DA1 handlers,
 *  and cap per-sequence and per-pane memory so inline images stay perf-safe. */
export function buildInlineImageAddonOptions(): IImageAddonOptions {
  return {
    // Why false: Orca already answers CSI 14t/16t via its pixel-size responder
    // and owns DA1 through its capability-reply handlers. Letting the addon set
    // windowOptions too would double-answer size queries into the shell.
    enableSizeReports: false,
    storageLimit: IMAGE_STORAGE_LIMIT_MB,
    sixelSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    iipSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    kittySizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT
  }
}
