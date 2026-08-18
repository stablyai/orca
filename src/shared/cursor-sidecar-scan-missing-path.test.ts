import { describe, expect, it } from 'vitest'
import {
  cursorSidecarScanCancellationFromSignal,
  discoverCursorSidecarCandidates
} from './cursor-sidecar-scan-discovery'
import type { CursorSidecarScanState } from './cursor-sidecar-scan'
import { retainCursorSidecarSessions } from './cursor-sidecar-scan-session-retention'

const missing = Object.assign(new Error('WSL share unavailable'), { code: 'ENOENT' })
const chatsRoot = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor\\chats'

describe('Cursor sidecar missing paths on WSL UNC storage', () => {
  it('reports a missing root when no ancestor proves the share is reachable', async () => {
    const response = emptyScanState()
    const discovery = await discoverCursorSidecarCandidates({
      chatsRoot,
      scopePaths: [],
      caps: { buckets: 1, sessions: 1, scopes: 1, sidecarBytes: 1, aggregateBytes: 1 },
      response,
      cancellation: cursorSidecarScanCancellationFromSignal(),
      io: {
        realpath: unavailable,
        lstat: unavailable
      }
    })

    expect(discovery).toBeNull()
    expect(response.issues).toEqual([{ path: chatsRoot, message: 'WSL share unavailable' }])
  })

  it('reports a missing bucket when no ancestor proves the share is reachable', async () => {
    const response = emptyScanState()
    const bucketPath = `${chatsRoot}\\11111111111111111111111111111111`
    const retained = await retainCursorSidecarSessions({
      buckets: [{ name: '11111111111111111111111111111111', path: bucketPath, scopeCwd: null }],
      sessionLimit: 1,
      response,
      cancellation: cursorSidecarScanCancellationFromSignal(),
      io: {
        realpath: async (path) => path,
        lstat: unavailable,
        opendir: unavailable
      }
    })

    expect(retained).toEqual([])
    expect(response.issues).toEqual([{ path: bucketPath, message: 'WSL share unavailable' }])
  })
})

async function unavailable(): Promise<never> {
  throw missing
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
