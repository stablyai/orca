import { describe, expect, it } from 'vitest'
import {
  MAX_PTY_INACTIVE_CLEANUP_IDS,
  normalizePtyInactiveCleanupIds
} from './pty-inactive-cleanup'

describe('normalizePtyInactiveCleanupIds', () => {
  it('keeps unique non-empty ids in request order', () => {
    expect(normalizePtyInactiveCleanupIds(['pty-a', '', 'pty-a', 7, 'pty-b'])).toEqual([
      'pty-a',
      'pty-b'
    ])
  })

  it('rejects non-arrays and caps the batch', () => {
    expect(normalizePtyInactiveCleanupIds(null)).toEqual([])
    expect(
      normalizePtyInactiveCleanupIds(
        Array.from({ length: MAX_PTY_INACTIVE_CLEANUP_IDS + 5 }, (_, index) => `pty-${index}`)
      )
    ).toHaveLength(MAX_PTY_INACTIVE_CLEANUP_IDS)
  })
})
