import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerInFlightWorkspaceCleanupScan } from './workspace-cleanup-broad-scan-registry'
import {
  beginWorkspaceCleanupScan,
  invalidateWorkspaceCleanupScanProgress,
  isLatestWorkspaceCleanupScan
} from './workspace-cleanup-scan-progress'

describe('workspace cleanup stale scan guard', () => {
  const cancelScan = vi.fn(async () => true)

  beforeEach(() => {
    cancelScan.mockReset()
    ;(globalThis as { window: unknown }).window = {
      api: { workspaceCleanup: { cancelScan } }
    }
  })

  it('revokes the current token before removal pruning can expose late progress', () => {
    const staleToken = beginWorkspaceCleanupScan()
    registerInFlightWorkspaceCleanupScan(
      'native:repo-1',
      'scan-before-removal',
      new Promise<never>(() => undefined)
    )
    expect(isLatestWorkspaceCleanupScan(staleToken)).toBe(true)

    invalidateWorkspaceCleanupScanProgress()

    expect(isLatestWorkspaceCleanupScan(staleToken)).toBe(false)
    expect(cancelScan).toHaveBeenCalledExactlyOnceWith('scan-before-removal')
  })

  it('lets only the newest broad scan mutate shared progress', () => {
    const first = beginWorkspaceCleanupScan()
    const second = beginWorkspaceCleanupScan()
    expect(isLatestWorkspaceCleanupScan(first)).toBe(false)
    expect(isLatestWorkspaceCleanupScan(second)).toBe(true)
  })
})
