import { describe, expect, it } from 'vitest'
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readNodeFileHandleWithinLimit } from './node-bounded-file-reader'

async function withFile(run: (path: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'orca-window-read-'))
  const path = join(root, 'data')
  await writeFile(path, 'prefix-IMAGE-trailer')
  try {
    await run(path)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

describe('bounded file read window', () => {
  it('reads only the requested extent of a larger file', async () => {
    await withFile(async (path) => {
      const handle = await open(path, 'r')
      try {
        const result = await readNodeFileHandleWithinLimit(handle, 5, {
          window: { offset: 7, length: 5 }
        })
        expect(result.buffer.toString()).toBe('IMAGE')
        const tail = await readNodeFileHandleWithinLimit(handle, 8, { window: { offset: 12 } })
        expect(tail.buffer.toString()).toBe('-trailer')
      } finally {
        await handle.close()
      }
    })
  })

  it.each([
    { offset: -1 },
    { offset: 1.5 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { offset: 0, length: -1 },
    { offset: 0, length: 1.5 },
    { offset: 0, length: 20 },
    { offset: 19, length: 2 },
    { offset: 21 }
  ])('rejects invalid or incomplete window %j', async (window) => {
    await withFile(async (path) => {
      const handle = await open(path, 'r')
      try {
        await expect(readNodeFileHandleWithinLimit(handle, 19, { window })).rejects.toThrow()
      } finally {
        await handle.close()
      }
    })
  })

  it('rejects bytes over the cap and honors cancellation before reading', async () => {
    await withFile(async (path) => {
      const handle = await open(path, 'r')
      try {
        await expect(
          readNodeFileHandleWithinLimit(handle, 4, {
            window: { offset: 7, length: 5 }
          })
        ).rejects.toThrow('File too large')
        const controller = new AbortController()
        controller.abort(new Error('cancelled file'))
        await expect(
          readNodeFileHandleWithinLimit(handle, 19, {
            window: { offset: 0 },
            signal: controller.signal
          })
        ).rejects.toThrow('cancelled file')
      } finally {
        await handle.close()
      }
    })
  })
})
