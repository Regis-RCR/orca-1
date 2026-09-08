import { expect, type Page } from '@stablyai/playwright-test'
import { PNG } from 'pngjs'

export function inlineImageProducer(): string {
  const png = new PNG({ width: 120, height: 36 })
  for (let i = 0; i < png.data.length; i += 4) {
    png.data.set([240, 40, 40, 255], i)
  }
  const encoded = PNG.sync.write(png).toString('base64')
  const payload =
    `\x1bcSSH / REMOTE INLINE IMAGE PROOF\r\n\r\n` +
    `iTerm2: red\r\n` +
    `\x1b]1337;File=inline=1;width=120px;height=36px:${encoded}\x07` +
    `\r\n\r\nSIXEL: green\r\n` +
    `\x1bPq"1;1;120;36#0;2;0;100;0${'#0!120~-'.repeat(6)}\x1b\\` +
    `\r\n\r\nKitty: blue\r\n` +
    `\x1b_Ga=T,f=24,s=120,v=36,q=2;${Buffer.from(
      Array.from({ length: 120 * 36 }, () => [40, 40, 240]).flat()
    ).toString('base64')}\x1b\\` +
    `\r\n\r\n`
  return (
    `const payload = Buffer.from('${Buffer.from(payload).toString('base64')}', 'base64');\n` +
    `process.stdout.write(payload);\n` +
    `console.log('IMAGE_PROOF_' + process.argv[2]);\n`
  )
}

export async function enableInlineImages(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await window.__store!.getState().updateSettings({ terminalInlineImages: true })
  })
  await expect.poll(() => readInlineImageState(page), { timeout: 30_000 }).not.toBeNull()
}

export async function readInlineImageState(page: Page) {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const manager = window.__paneManagers?.get(state.activeTabId!)
    const terminal = manager?.getActivePane()?.terminal
    type ImageInternals = {
      _addonManager: {
        _addons: {
          instance: {
            _storage?: { _images: Map<number, unknown> }
            _handlers?: Map<
              string,
              {
                _pendingTransmissions?: Map<number, { decoder: { _mem: { buffer: ArrayBuffer } } }>
              }
            >
            storageUsage?: number
          }
        }[]
      }
    }
    const addon = (terminal as unknown as ImageInternals | undefined)?._addonManager._addons
      .map((entry) => entry.instance)
      .find((entry) => entry._handlers?.has('kitty'))
    if (!addon) {
      return null
    }
    const pending = [...(addon._handlers?.get('kitty')?._pendingTransmissions?.values() ?? [])]
    return {
      images: addon._storage?._images.size ?? 0,
      storageMB: addon.storageUsage ?? 0,
      pending: pending.length,
      decoderBytes: pending.reduce((sum, upload) => sum + upload.decoder._mem.buffer.byteLength, 0)
    }
  })
}

export async function assertInlineImagePixels(page: Page, screenshotPath: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const png = PNG.sync.read(await page.screenshot({ path: screenshotPath }))
        const counts = [0, 0, 0]
        for (let i = 0; i < png.data.length; i += 4) {
          const [r, g, b] = png.data.subarray(i, i + 3)
          if (r > 220 && g < 60 && b < 60) {
            counts[0]++
          }
          if (g > 220 && r < 60 && b < 60) {
            counts[1]++
          }
          if (b > 220 && r < 60 && g < 60) {
            counts[2]++
          }
        }
        return Math.min(...counts)
      },
      {
        timeout: 30_000,
        message: 'All three protocol images must appear in the rendered screenshot'
      }
    )
    .toBeGreaterThan(1000)
}
