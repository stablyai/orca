import { describe, expect, it } from 'vitest'
import { getSelectedNestedRepoPathsInScanOrder } from './nested-repo-selected-paths'

describe('getSelectedNestedRepoPathsInScanOrder', () => {
  it('keeps selected paths in scan order instead of Set insertion order', () => {
    const selectedPaths = new Set([
      '/workspace/platform/web',
      '/workspace/platform/worker',
      '/workspace/platform/api'
    ])
    selectedPaths.delete('/workspace/platform/worker')
    selectedPaths.add('/workspace/platform/worker')

    expect(
      getSelectedNestedRepoPathsInScanOrder(
        {
          repos: [
            { path: '/workspace/platform/web', displayName: 'web', depth: 1 },
            { path: '/workspace/platform/worker', displayName: 'worker', depth: 1 },
            { path: '/workspace/platform/api', displayName: 'api', depth: 1 }
          ]
        },
        selectedPaths
      )
    ).toEqual(['/workspace/platform/web', '/workspace/platform/worker', '/workspace/platform/api'])
  })
})
