import { describe, expect, it, vi } from 'vitest'
import type { Stats } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import {
  isVerifiedFileDescendant,
  readBoundedFileHandle,
  readVerifiedBoundedTextFile
} from './node-verified-bounded-text-file'

describe('readBoundedFileHandle', () => {
  it('keeps WSL filesystem path segments case-sensitive', () => {
    const root = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor\\chats'
    expect(isVerifiedFileDescendant(root, `${root}\\bucket\\session\\meta.json`)).toBe(true)
    expect(
      isVerifiedFileDescendant(
        root,
        '\\\\wsl.localhost\\ubuntu\\home\\ada\\.cursor\\Chats\\meta.json'
      )
    ).toBe(false)
  })

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

  it('rejects when a provider cannot report stable file identity', async () => {
    const root = resolve('cursor-identity-root')
    const filePath = join(root, 'session', 'meta.json')
    const beforeOpen = fakeStats('file', 6, 10)
    const opened = fakeStats('file', 6, 10)
    const handle = {
      close: vi.fn(async () => undefined),
      read: vi.fn(),
      stat: vi.fn(async () => opened)
    }

    await expect(
      readVerifiedBoundedTextFile(filePath, {
        expectedRootRealPath: root,
        maxBytes: 100,
        io: {
          realpath: async (path) => path,
          lstat: async (path) =>
            path === dirname(filePath) ? fakeStats('directory', 0, 0) : beforeOpen,
          open: async () => handle as unknown as FileHandle
        }
      })
    ).rejects.toThrow('verified_file_changed')
    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
  })

  it('rejects when file identity becomes available only after open', async () => {
    const root = resolve('cursor-identity-root')
    const filePath = join(root, 'session', 'meta.json')
    const handle = {
      close: vi.fn(async () => undefined),
      read: vi.fn(),
      stat: vi.fn(async () => fakeStats('file', 6, 10, 2, 3))
    }

    await expect(
      readVerifiedBoundedTextFile(filePath, {
        expectedRootRealPath: root,
        maxBytes: 100,
        io: {
          realpath: async (path) => path,
          lstat: async (path) =>
            path === dirname(filePath) ? fakeStats('directory', 0, 0) : fakeStats('file', 6, 10),
          open: async () => handle as unknown as FileHandle
        }
      })
    ).rejects.toThrow('verified_file_changed')
    expect(handle.read).not.toHaveBeenCalled()
    expect(handle.close).toHaveBeenCalledOnce()
  })
})

function fakeStats(
  kind: 'directory' | 'file',
  size: number,
  mtimeMs: number,
  dev = 0,
  ino = 0
): Stats {
  return {
    dev,
    ino,
    mtimeMs,
    size,
    isDirectory: () => kind === 'directory',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false
  } as unknown as Stats
}
