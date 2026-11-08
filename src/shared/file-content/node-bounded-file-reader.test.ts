import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }))

vi.mock('node:fs/promises', () => ({ open: openMock }))

import { readNodeFileWithinLimit } from './node-bounded-file-reader'

type FileHandleOptions = {
  content: Buffer
  initialSize?: number
  readError?: Error
  statError?: Error
  firstReadOnly?: boolean
}

function createFileHandle({
  content,
  initialSize,
  readError,
  statError,
  firstReadOnly
}: FileHandleOptions) {
  const close = vi.fn().mockResolvedValue(undefined)
  const read = vi.fn(async (target: Buffer, offset: number, length: number, position: number) => {
    if (readError) {
      throw readError
    }
    if (firstReadOnly && position > 0) {
      return { bytesRead: 0, buffer: target }
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
  it('reads the full sysctl value when later offsets return EOF', async () => {
    const handle = createFileHandle({
      content: Buffer.from('4096\n'),
      initialSize: 0,
      firstReadOnly: true
    })
    openMock.mockResolvedValue(handle)

    const result = await readNodeFileWithinLimit('/proc/sys/kernel/pty/max', 1024)

    expect(result.buffer.toString('utf8')).toBe('4096\n')
  })
})
