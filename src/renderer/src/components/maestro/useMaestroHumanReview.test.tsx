// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MaestroHumanReview } from '../../../../shared/maestro-human-review'
import type { MaestroProjection } from '../../../../shared/maestro-projection'
import { useMaestroHumanReview } from './useMaestroHumanReview'

const { callRuntimeRpc } = vi.hoisted(() => ({ callRuntimeRpc: vi.fn() }))

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc }))

const projection = {
  repositoryId: 'repo-1',
  runId: 'run-1',
  workspace: { executionHostId: 'local', workspaceKey: 'folder:workspace-1' },
  revision: 1
} as MaestroProjection
const target = { kind: 'local' } as const

afterEach(() => {
  vi.clearAllMocks()
})

describe('useMaestroHumanReview', () => {
  it('keeps polling bound to a stable workspace identity across projection refreshes', async () => {
    callRuntimeRpc.mockResolvedValue({ reviews: [] })
    const { rerender, unmount } = renderHook(({ value }) => useMaestroHumanReview(target, value), {
      initialProps: { value: projection }
    })

    await act(async () => undefined)
    expect(callRuntimeRpc).toHaveBeenCalledOnce()

    rerender({ value: { ...projection, revision: 2 } })
    await act(async () => undefined)

    expect(callRuntimeRpc).toHaveBeenCalledOnce()
    unmount()
  })

  it('forwards host-issued Browser profile consent for exact review focus', async () => {
    const consent = {
      schema_version: 1 as const,
      protocol: 'maestro-browser-profile-consent/v1' as const,
      consent_id: 'consent-1',
      profile_id: 'profile-1',
      run_id: 'run-1',
      task_id: 'task-1',
      attempt_id: 'dispatch-1',
      granted_by: { actor_id: 'human-1', kind: 'user' as const, authenticated: true as const },
      granted_at: '2026-08-31T20:00:00.000Z',
      expires_at: '2026-09-01T20:00:00.000Z',
      revoked_at: null
    }
    const review = {
      review_id: 'review-1',
      coordinator_generation: 1,
      references: {
        browser: {
          surface_id: 'surface-1',
          browser_page_id: 'page-1',
          profile_consent_receipt: consent
        }
      },
      workspace: {
        repository_id: 'repo-1',
        execution_host_id: 'local',
        workspace_key: 'folder:workspace-1',
        run_id: 'run-1'
      }
    } as MaestroHumanReview
    callRuntimeRpc.mockResolvedValueOnce({ reviews: [] }).mockResolvedValueOnce({
      surface_id: 'surface-1',
      browser_page_id: 'page-1'
    })
    const { result, unmount } = renderHook(() => useMaestroHumanReview(target, projection))
    await act(async () => undefined)

    await act(async () => result.current.focusBrowser(review))

    expect(callRuntimeRpc).toHaveBeenLastCalledWith(
      target,
      'orchestration.browserSurface.focus',
      expect.objectContaining({ profile_consent_receipt: consent })
    )
    unmount()
  })
})
