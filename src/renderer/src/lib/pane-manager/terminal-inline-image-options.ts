import type { IImageAddonOptions } from '@xterm/addon-image'

// Per-sequence byte ceiling for every protocol. Bounds the decoder's working
// buffer so one oversized paste cannot stall the parser or balloon memory; 8 MB
// of encoded data still covers any reasonable inline image.
const IMAGE_SEQUENCE_SIZE_LIMIT = 8 * 1024 * 1024

// Per-pane decoded-image cache before FIFO eviction (MB of RGBA).
// This is not a process-wide memory limit; budgets add up across panes.
const IMAGE_STORAGE_LIMIT_MB = 32

/** Bound image sequences and per-pane caches without enabling duplicate size reports. */
export function buildInlineImageAddonOptions(): IImageAddonOptions {
  return {
    // Orca already answers CSI 14t/16t via its pixel-size responder.
    enableSizeReports: false,
    storageLimit: IMAGE_STORAGE_LIMIT_MB,
    pixelLimit: (IMAGE_STORAGE_LIMIT_MB * 1000000) / 4,
    sixelSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    iipSizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT,
    kittySizeLimit: IMAGE_SEQUENCE_SIZE_LIMIT
  }
}
