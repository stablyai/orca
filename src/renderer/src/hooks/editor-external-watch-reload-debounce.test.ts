import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notify = vi.hoisted(() => vi.fn())
vi.mock('@/components/editor/editor-autosave', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  notifyEditorExternalFileChange: notify
}))

import { scheduleDebouncedEditorExternalReload } from './editor-external-watch-disk-verification'

describe('scheduleDebouncedEditorExternalReload', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    notify.mockReset()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps dispatching while same-path events never pause', () => {
    const notification = {
      worktreeId: 'wt',
      worktreePath: '/repo',
      relativePath: 'a.ts',
      runtimeEnvironmentId: null
    }
    // Events closer together than the debounce must not starve the reload.
    for (let elapsed = 0; elapsed < 1_000; elapsed += 50) {
      scheduleDebouncedEditorExternalReload(notification)
      vi.advanceTimersByTime(50)
    }
    expect(notify.mock.calls.length).toBeGreaterThanOrEqual(5)
  })
})
