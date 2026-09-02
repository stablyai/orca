import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ open: openMock }))

import { NodeFileReadTooLargeError, readNodeFileWithinLimit } from './node-bounded-file-reader'

type FileHandleOptions = {
  content: Buffer
  initialSize?: number
  readError?: Error
  statError?: Error
}

function createFileHandle({ content, initialSize, readError, statError }: FileHandleOptions) {
  const close = vi.fn().mockResolvedValue(undefined)
  const read = vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
    if (readError) {
      throw readError
    }
    const bytesRead = Math.min(length, Math.max(0, content.byteLength - position))
    content.copy(target, offset, position, position + bytesRead)
    return { bytesRead, buffer: target }
  })
  const stat = statError
    ? vi.fn().mockRejectedValue(statError)
    : vi.fn().mockResolvedValue({ size: initialSize ?? content.byteLength })
  return { close, read, stat }
}

beforeEach(() => openMock.mockReset())

describe('readNodeFileWithinLimit', () => {
  it('reads a stable file and closes its descriptor', async () => {
    const handle = createFileHandle({ content: Buffer.from('stable') })
    openMock.mockResolvedValue(handle)

    const result = await readNodeFileWithinLimit('/workspace/stable.txt', 64)

    expect(result.buffer).toEqual(Buffer.from('stable'))
    expect(result.stats.size).toBe(6)
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('rejects an oversized initial size before reading file bytes', async () => {
    const handle = createFileHandle({ content: Buffer.alloc(0), initialSize: 65 })
    openMock.mockResolvedValue(handle)

    await expect(readNodeFileWithinLimit('/workspace/oversized.txt', 64)).rejects.toEqual(
      new NodeFileReadTooLargeError(65, 64)
    )
    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('includes growth that remains within the read limit', async () => {
    const handle = createFileHandle({ content: Buffer.from('grown'), initialSize: 3 })
    openMock.mockResolvedValue(handle)

    const result = await readNodeFileWithinLimit('/workspace/growing.txt', 5)

    expect(result.buffer).toEqual(Buffer.from('grown'))
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('reads proc-style content whose reported file size is zero', async () => {
    const handle = createFileHandle({ content: Buffer.from('proc table'), initialSize: 0 })
    openMock.mockResolvedValue(handle)

    const result = await readNodeFileWithinLimit('/proc/net/tcp', 64)

    expect(result.buffer).toEqual(Buffer.from('proc table'))
    expect(result.stats.size).toBe(0)
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('rejects growth beyond the limit without allocating the oversized content', async () => {
    const handle = createFileHandle({ content: Buffer.from('growth'), initialSize: 3 })
    openMock.mockResolvedValue(handle)

    await expect(readNodeFileWithinLimit('/workspace/growing.txt', 5)).rejects.toEqual(
      new NodeFileReadTooLargeError(6, 5)
    )
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it.each([
    { label: 'stat', options: { content: Buffer.alloc(0), statError: new Error('stat failed') } },
    {
      label: 'read',
      options: { content: Buffer.from('data'), readError: new Error('read failed') }
    }
  ])('closes its descriptor when $label fails', async ({ options }) => {
    const handle = createFileHandle(options)
    openMock.mockResolvedValue(handle)

    await expect(readNodeFileWithinLimit('/workspace/failing.txt', 64)).rejects.toThrow(
      `${options.statError ? 'stat' : 'read'} failed`
    )
    expect(handle.close).toHaveBeenCalledOnce()
  })
})
