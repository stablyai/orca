import { it, vi, expect, beforeEach, describe } from 'vitest'
import type { NestedRepoScanResult } from '../../../../shared/project-group-types'
import { createTestStore } from '../slices/store-test-helpers'

const LOCAL_OWNER = { runtimeEnvironmentId: null }
const projectGroupsScanNested = vi.fn()
const projectGroupsOnNestedScanProgress = vi.fn()

beforeEach(() => {
  projectGroupsScanNested.mockReset()
  projectGroupsOnNestedScanProgress.mockReset()
  projectGroupsOnNestedScanProgress.mockReturnValue(vi.fn())
  vi.stubGlobal('window', {
    api: {
      projectGroups: {
        scanNested: projectGroupsScanNested,
        onNestedScanProgress: projectGroupsOnNestedScanProgress
      }
    }
  })
})

describe('project group store routing', () => {
  it('routes local nested scan progress by scanId and unsubscribes after completion', async () => {
    const unsubscribe = vi.fn()
    const progressCallback = vi.fn()
    const matchingScan = {
      selectedPath: '/platform',
      selectedPathKind: 'non_git_folder' as const,
      repos: [{ path: '/platform/api', displayName: 'api', depth: 1 }],
      truncated: false,
      timedOut: false,
      stopped: false,
      durationMs: 10,
      maxDepth: 3,
      maxRepos: 100,
      timeoutMs: null
    }
    projectGroupsOnNestedScanProgress.mockImplementation(
      (listener: (data: { scanId: string; scan: NestedRepoScanResult }) => void) => {
        listener({ scanId: 'other-scan', scan: { ...matchingScan, repos: [] } })
        listener({ scanId: 'scan-1', scan: matchingScan })
        return unsubscribe
      }
    )
    projectGroupsScanNested.mockResolvedValue(matchingScan)
    const store = createTestStore()

    await expect(
      store.getState().scanNestedRepos('/platform', undefined, {
        ...LOCAL_OWNER,
        scanId: 'scan-1',
        onProgress: progressCallback
      })
    ).resolves.toEqual(matchingScan)

    expect(progressCallback).not.toHaveBeenCalledWith({ ...matchingScan, repos: [] })
    expect(progressCallback).toHaveBeenCalledWith(matchingScan)
    expect(projectGroupsScanNested).toHaveBeenCalledWith({
      path: '/platform',
      connectionId: undefined,
      scanId: 'scan-1'
    })
    expect(unsubscribe).toHaveBeenCalled()
  })
})
