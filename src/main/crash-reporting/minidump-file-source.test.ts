import { mkdtemp, open, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { createMinidumpFileSource } from './minidump-file-source'
import { parseMinidumpCrashSignature } from './minidump-crash-signature'

const roots: string[] = []
const LINE = '[8104:1234:0815/143022.123456:FATAL:render_frame_impl.cc(4821)] Check failed: !x.'
const ERROR = '[8104:1234:0815/143022.123456:ERROR:file.cc(12)] Check failed: earlier.'
const BLOCK = 1024 * 1024

function header(): Buffer {
  const bytes = Buffer.alloc(32)
  bytes.writeUInt32LE(0x504d444d, 0)
  bytes.writeUInt32LE(32, 12)
  return bytes
}

async function sourceFile() {
  const root = await mkdtemp(join(tmpdir(), 'orca-minidump-source-'))
  roots.push(root)
  const path = join(root, 'dump.dmp')
  await writeFile(path, header())
  return path
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

it.each([-96, -40, -1, 0, 1, 40, 96])(
  'preserves marker and full text at block boundary %+d',
  async (delta) => {
    const path = await sourceFile()
    const handle = await open(path, 'r+')
    const line = LINE + 'x'.repeat(4000 - LINE.length)
    try {
      await handle.write(Buffer.from(`${line}\0`), 0, line.length + 1, BLOCK + delta)
      const { size } = await handle.stat()
      const streamed = await parseMinidumpCrashSignature(createMinidumpFileSource(handle, size))
      const complete = await handle.readFile()
      expect(streamed).toEqual(await parseMinidumpCrashSignature(complete))
      expect(streamed?.checkMessage).toBe(line)
    } finally {
      await handle.close()
    }
  }
)

it('preserves severity priority across blocks and scans a large sparse dump with bounded reads', async () => {
  const path = await sourceFile()
  const handle = await open(path, 'r+')
  const size = 80 * 1024 * 1024
  try {
    await handle.write(Buffer.from(`${ERROR}\0`), 0, ERROR.length + 1, 4096)
    await handle.write(Buffer.from(`${LINE}\0`), 0, LINE.length + 1, size - LINE.length - 1)
    const source = createMinidumpFileSource(handle, size)
    let maxRead = 0
    let reads = 0
    const result = await parseMinidumpCrashSignature({
      byteLength: size,
      read: async (offset, length) => {
        maxRead = Math.max(maxRead, length)
        reads++
        return source.read(offset, length)
      }
    })
    expect(result?.checkMessage).toBe(LINE)
    expect(maxRead).toBeLessThanOrEqual(BLOCK + 4096)
    expect(reads).toBeLessThan(400)
  } finally {
    await handle.close()
  }
})

it('reads annotations through large RVAs without buffering skipped process memory', async () => {
  const path = await sourceFile()
  const handle = await open(path, 'r+')
  const rva = 80 * 1024 * 1024
  try {
    const prefix = Buffer.alloc(44)
    header().copy(prefix)
    prefix.writeUInt32LE(1, 8)
    prefix.writeUInt32LE(0x43500001, 32)
    prefix.writeUInt32LE(52, 36)
    prefix.writeUInt32LE(rva, 40)
    await handle.write(prefix, 0, prefix.length, 0)
    const info = Buffer.alloc(52 + 12 + 10 + 13)
    info.writeUInt32LE(1, 0)
    info.writeUInt32LE(12, 36)
    info.writeUInt32LE(rva + 52, 40)
    info.writeUInt32LE(1, 52)
    info.writeUInt32LE(rva + 64, 56)
    info.writeUInt32LE(rva + 74, 60)
    info.writeUInt32LE(5, 64)
    info.write('ptype', 68)
    info.writeUInt32LE(8, 74)
    info.write('renderer', 78)
    await handle.write(info, 0, info.length, rva)
    const source = createMinidumpFileSource(handle, rva + info.length)
    const reads: number[] = []
    const result = await parseMinidumpCrashSignature(
      {
        byteLength: source.byteLength,
        read: async (offset, length) => {
          reads.push(length)
          return source.read(offset, length)
        }
      },
      { expectedProcessType: 'browser' }
    )
    expect(result).toEqual({ annotations: { ptype: 'renderer' }, processType: 'renderer' })
    expect(Math.max(...reads)).toBeLessThan(64)
  } finally {
    await handle.close()
  }
})

it('does not read outside the opened extent, including truncation and EOF', async () => {
  const path = await sourceFile()
  const handle = await open(path, 'r+')
  try {
    const source = createMinidumpFileSource(handle, 32)
    await handle.write(Buffer.from(LINE), 0, LINE.length, 32)
    expect(await source.read(32, 4)).toEqual(Buffer.alloc(0))
    expect((await parseMinidumpCrashSignature(source))?.checkMessage).toBeUndefined()
    await truncate(path, 4)
    const truncated = createMinidumpFileSource(handle, 32)
    expect(await parseMinidumpCrashSignature(truncated)).toBeNull()
  } finally {
    await handle.close()
  }
})
