import type { Dirent } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import {
  CURSOR_SIDECAR_MAX_SESSION_ENTRIES_EXAMINED,
  type CursorSidecarScanState
} from './cursor-sidecar-scan'
import type { CursorDirectoryStream } from './cursor-sidecar-scan-directory'
import { retainCursorSidecarSessions } from './cursor-sidecar-scan-session-retention'

describe('Cursor sidecar session retention', () => {
  it('shares one entry-examination budget across unscoped buckets', async () => {
    const bucketCount = 256
    const openDirectory = vi.fn(async () => invalidDirectoryStream())
    const response = emptyScanState()

    const retained = await retainCursorSidecarSessions({
      buckets: Array.from({ length: bucketCount }, (_, index) => ({
        name: index.toString(16).padStart(32, '0'),
        path: `/chats/${index}`,
        scopeCwd: null
      })),
      sessionLimit: 2_000,
      response,
      cancellation: { throwIfCancelled: () => undefined },
      io: {
        realpath: async (path) => path,
        lstat: vi.fn(),
        opendir: openDirectory
      }
    })

    expect(retained).toEqual([])
    expect(response.counters.direntsRead).toBe(CURSOR_SIDECAR_MAX_SESSION_ENTRIES_EXAMINED + 8)
    expect(response.counters.bucketReaddir).toBe(8)
    expect(openDirectory).toHaveBeenCalledTimes(8)
    expect(response.truncated.sessionDirs).toBe(true)
  })
})

function invalidDirectoryStream(): CursorDirectoryStream {
  const entry = {
    name: 'not-a-session-file',
    isDirectory: () => false,
    isSymbolicLink: () => false
  } as unknown as Dirent
  return {
    close: async () => undefined,
    read: async () => null,
    async *[Symbol.asyncIterator]() {
      for (let index = 0; index <= CURSOR_SIDECAR_MAX_SESSION_ENTRIES_EXAMINED; index++) {
        yield entry
      }
    }
  } as CursorDirectoryStream
}

function emptyScanState(): CursorSidecarScanState {
  return {
    issues: [],
    counters: {
      rootReaddir: 0,
      bucketReaddir: 0,
      direntsRead: 0,
      fileLstat: 0,
      boundedReads: 0,
      scopeRealpath: 0,
      returnedBytes: 0,
      elapsedMs: 0
    },
    truncated: { scopePaths: false, buckets: false, sessionDirs: false, sidecarBytes: false }
  }
}
