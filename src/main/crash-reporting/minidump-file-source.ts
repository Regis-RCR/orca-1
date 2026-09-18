import type { FileHandle } from 'node:fs/promises'
import type { MinidumpSource } from './minidump-stream-reader'

const PAGE_BYTES = 64 * 1024

/** Size-zero readFile follows bytes until EOF, even when an open races the writer. */
export async function observeMinidumpExtent(
  handle: FileHandle,
  initialSize: number
): Promise<number> {
  if (initialSize !== 0) {
    return initialSize
  }
  const bytes = Buffer.allocUnsafe(PAGE_BYTES)
  let size = 0
  while (true) {
    const result = await handle.read(bytes, 0, bytes.length, size)
    if (result.bytesRead === 0) {
      return size
    }
    size += result.bytesRead
  }
}

/** Keep metadata seeks cheap without retaining the dump's captured process memory. */
export function createMinidumpFileSource(handle: FileHandle, byteLength: number): MinidumpSource {
  let page: Buffer = Buffer.alloc(0)
  let pageOffset = 0

  async function readRange(offset: number, size: number): Promise<Buffer> {
    const bytes = Buffer.allocUnsafe(size)
    let read = 0
    while (read < size) {
      const result = await handle.read(bytes, read, size - read, offset + read)
      if (result.bytesRead === 0) {
        break
      }
      read += result.bytesRead
    }
    return bytes.subarray(0, read)
  }

  return {
    byteLength,
    async read(offset, size) {
      const length = Math.max(0, Math.min(size, byteLength - offset))
      if (length === 0) {
        return Buffer.alloc(0)
      }
      if (offset >= pageOffset && offset + length <= pageOffset + page.length) {
        return page.subarray(offset - pageOffset, offset - pageOffset + length)
      }
      if (length > PAGE_BYTES) {
        return readRange(offset, length)
      }
      pageOffset = offset
      page = await readRange(offset, Math.min(PAGE_BYTES, byteLength - offset))
      return page.subarray(0, length)
    }
  }
}
