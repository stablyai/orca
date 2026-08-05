import { describe, expect, it, vi } from 'vitest'
import type { FileHandle } from 'node:fs/promises'
import { readBoundedFileHandle } from './node-verified-bounded-text-file'

describe('readBoundedFileHandle', () => {
  it('continues after short reads until EOF', async () => {
    const source = Buffer.from('abcdef')
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Math.min(2, length, source.length - position)
      if (bytesRead > 0) {
        source.copy(buffer, offset, position, position + bytesRead)
      }
      return { bytesRead, buffer }
    })

    await expect(
      readBoundedFileHandle({ read } as unknown as FileHandle, source.length)
    ).resolves.toEqual(source)
    expect(read).toHaveBeenCalledTimes(4)
  })

  it('detects an oversized file even when the first read is short', async () => {
    const source = Buffer.from('abcdefg')
    const read = vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => {
      const bytesRead = Math.min(2, length, source.length - position)
      if (bytesRead > 0) {
        source.copy(buffer, offset, position, position + bytesRead)
      }
      return { bytesRead, buffer }
    })

    await expect(
      readBoundedFileHandle({ read } as unknown as FileHandle, source.length - 1)
    ).rejects.toThrow('file_too_large')
  })
})
