// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GitLabWorkItem } from '../../../../shared/gitlab-types'
import type { GitLabItemDialogState } from './use-gitlab-item-dialog-state'
import { useGitLabPrimaryActions } from './use-gitlab-primary-actions'

const mocks = vi.hoisted(() => ({
  mergeMR: vi.fn(),
  toastError: vi.fn()
}))

vi.mock('@/runtime/gitlab-owner-api', () => ({
  gitLabApiFor: () => ({ mergeMR: mocks.mergeMR })
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, success: vi.fn() } }))

describe('useGitLabPrimaryActions', () => {
  it('rereads after a returned merge failure and keeps the error toast', async () => {
    mocks.mergeMR.mockResolvedValue({ ok: false, error: 'Connection lost' })
    const events: string[] = []
    const state = {
      commentDraft: '',
      mountedRef: { current: true },
      setActionInFlight: (value: string | null) => events.push(`inFlight:${value}`),
      setCommentDraftState: vi.fn(),
      setCommentSubmitting: vi.fn()
    } as unknown as GitLabItemDialogState
    const { result } = renderHook(() =>
      useGitLabPrimaryActions(
        { id: 'mr:7', type: 'mr', number: 7 } as GitLabWorkItem,
        'mr:7',
        { repoPath: '/repo' },
        state,
        () => events.push('reread')
      )
    )

    await act(async () => result.current.handleMerge())

    expect(mocks.toastError).toHaveBeenCalledWith('Connection lost')
    expect(events).toEqual(['inFlight:merge', 'inFlight:null', 'reread'])
  })
})
