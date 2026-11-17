// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  blobUrlCache,
  cacheLocalImageBlob,
  getLocalImageCacheGeneration,
  invalidateLocalImageCache,
  resetLocalImageCacheState,
  subscribeToLocalImageCacheInvalidation
} from './local-image-src-cache'
import { ORCA_WORKTREE_FILE_CHANGE_EVENT } from '@/hooks/worktree-file-change-event'

describe('local-image-src-cache', () => {
  beforeEach(() => {
    resetLocalImageCacheState()
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
  })

  afterEach(() => {
    resetLocalImageCacheState()
    vi.restoreAllMocks()
  })

  it('invalidates a specific image path when targetPath is provided', () => {
    cacheLocalImageBlob('client\0\0local\0\0\0\0\0\0roots\0\0/worktree/fig.png', 'blob:fig-1', 100)
    cacheLocalImageBlob(
      'client\0\0local\0\0\0\0\0\0roots\0\0/worktree/other.png',
      'blob:other-1',
      100
    )

    let invalidated = false
    subscribeToLocalImageCacheInvalidation(() => {
      invalidated = true
    })

    invalidateLocalImageCache('/worktree/fig.png')

    expect(invalidated).toBe(true)
    expect(blobUrlCache.has('client\0\0local\0\0\0\0\0\0roots\0\0/worktree/fig.png')).toBe(false)
    expect(blobUrlCache.get('client\0\0local\0\0\0\0\0\0roots\0\0/worktree/other.png')).toBe(
      'blob:other-1'
    )
  })

  it('invalidates matching cached image when an ORCA_WORKTREE_FILE_CHANGE_EVENT fires for an image', () => {
    const key = 'client\0\0local\0\0\0\0\0\0roots\0\0/worktree/fig.png'
    cacheLocalImageBlob(key, 'blob:fig-1', 100)

    const genBefore = getLocalImageCacheGeneration()

    window.dispatchEvent(
      new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
        detail: {
          runtimeEnvironmentId: 'client',
          payload: {
            worktreePath: '/worktree',
            events: [{ kind: 'update', absolutePath: '/worktree/fig.png' }]
          }
        }
      })
    )

    expect(blobUrlCache.has(key)).toBe(false)
    expect(getLocalImageCacheGeneration()).toBe(genBefore + 1)
  })

  it('ignores non-image file changes in ORCA_WORKTREE_FILE_CHANGE_EVENT', () => {
    const key = 'client\0\0local\0\0\0\0\0\0roots\0\0/worktree/fig.png'
    cacheLocalImageBlob(key, 'blob:fig-1', 100)

    const genBefore = getLocalImageCacheGeneration()

    window.dispatchEvent(
      new CustomEvent(ORCA_WORKTREE_FILE_CHANGE_EVENT, {
        detail: {
          runtimeEnvironmentId: 'client',
          payload: {
            worktreePath: '/worktree',
            events: [{ kind: 'update', absolutePath: '/worktree/document.txt' }]
          }
        }
      })
    )

    expect(blobUrlCache.get(key)).toBe('blob:fig-1')
    expect(getLocalImageCacheGeneration()).toBe(genBefore)
  })
})
