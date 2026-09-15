import { beforeEach, describe, expect, it, vi } from 'vitest'

const { toastError } = vi.hoisted(() => ({
  toastError: vi.fn<(title: string, options?: { id?: string; description?: string }) => void>()
}))

vi.mock('sonner', () => ({ toast: { error: toastError } }))

import { showComposerDropFailureToast } from './composer-drop-failure-toast'
import type { ImportSkipReason } from '../../../shared/filesystem-import-result-types'

const SKIP_REASON_COPY = [
  ['missing', 'No longer at its original path.'],
  ['symlink', 'Symbolic links cannot be attached.'],
  ['permission-denied', 'Permission denied.'],
  ['unsupported', 'Unsupported file type.']
] as const satisfies readonly (readonly [ImportSkipReason, string])[]

function lastToast(): { title: string; id?: string; description?: string } {
  const call = toastError.mock.calls.at(-1)

  return {
    title: String(call?.[0]),
    id: call?.[1]?.id,
    description: call?.[1]?.description
  }
}

describe('showComposerDropFailureToast', () => {
  beforeEach(() => {
    toastError.mockClear()
  })

  it('stays neutral about the gesture, and pluralises like its namespace siblings', () => {
    showComposerDropFailureToast({ failureCount: 1, total: 1 })
    expect(lastToast().title).toBe('1 of 1 item could not be attached.')

    showComposerDropFailureToast({ failureCount: 2, total: 5 })
    expect(lastToast().title).toBe('2 of 5 items could not be attached.')
  })

  it("turns the import client's skip enum into copy instead of leaking the token", () => {
    for (const [reason, expected] of SKIP_REASON_COPY) {
      showComposerDropFailureToast({
        failureCount: 1,
        total: 3,
        commonFailure: { status: 'skipped', reason }
      })
      expect(lastToast().description).toBe(expected)
    }
  })

  it('passes a free-form failure reason straight through', () => {
    showComposerDropFailureToast({
      failureCount: 2,
      total: 4,
      commonFailure: { status: 'failed', reason: 'EACCES: permission denied' }
    })
    expect(lastToast().description).toBe('EACCES: permission denied')
  })

  it('shows no description when nothing explained the failure', () => {
    showComposerDropFailureToast({ failureCount: 1, total: 2 })
    expect(lastToast().description).toBeUndefined()
  })

  it('unwraps and clamps a host-minted failure reason before it reaches the row', () => {
    showComposerDropFailureToast({
      failureCount: 1,
      total: 2,
      commonFailure: {
        status: 'failed',
        reason:
          "Error invoking remote method 'runtime:call': Error: EACCES: permission denied\nat Object.upload"
      }
    })
    expect(lastToast().description).toBe('EACCES: permission denied')
  })

  it('reuses one slot so a second failed drop replaces the first instead of stacking', () => {
    showComposerDropFailureToast({ failureCount: 1, total: 2 })
    const first = lastToast().id
    showComposerDropFailureToast({ failureCount: 2, total: 3 })
    expect(first).toBeDefined()
    expect(lastToast().id).toBe(first)
  })

  it('gives no reason at all when the batch failed for differing reasons', () => {
    showComposerDropFailureToast({ failureCount: 3, total: 6 })
    expect(lastToast().title).toBe('3 of 6 items could not be attached.')
    expect(lastToast().description).toBeUndefined()
  })
})
