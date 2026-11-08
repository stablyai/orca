// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorktreeIconsApi } from '../../../../preload/api/worktree-icons-bridge'
import type { WorktreeIconGenerationResult } from '../../../../shared/worktree/worktree-icon-generation'
import { retryFailedWorktreeAiIcons, useWorktreeAiIcon } from './use-worktree-ai-icon'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

it('retries a failed icon on a mounted card and publishes the successful result', async () => {
  const failed = Promise.withResolvers<WorktreeIconGenerationResult>()
  const retry = Promise.withResolvers<WorktreeIconGenerationResult>()
  const generate = vi.fn().mockReturnValueOnce(failed.promise).mockReturnValueOnce(retry.promise)
  vi.stubGlobal('api', { worktreeIcons: { generate, cancel: async () => {} } })
  const hook = renderHook(() => useWorktreeAiIcon('retry mounted icon', true))
  await act(async () => failed.resolve({ success: false, error: 'unavailable' }))
  act(() => retryFailedWorktreeAiIcons())
  await act(async () => retry.resolve({ success: true, svg: '<svg/>' }))
  expect(hook.result.current).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E')
})

it('releases the last enabled card and ignores the abandoned attempt after remount', async () => {
  const abandoned = Promise.withResolvers<WorktreeIconGenerationResult>()
  const renewed = Promise.withResolvers<WorktreeIconGenerationResult>()
  const canceled: string[] = []
  const api: WorktreeIconsApi = {
    generate: vi.fn().mockReturnValueOnce(abandoned.promise).mockReturnValueOnce(renewed.promise),
    cancel: async ({ requestId }) => {
      canceled.push(requestId)
    }
  }
  vi.stubGlobal('api', { worktreeIcons: api })
  const first = renderHook(() => useWorktreeAiIcon('shared mounted icon', true))
  const second = renderHook(({ enabled }) => useWorktreeAiIcon('shared mounted icon', enabled), {
    initialProps: { enabled: true }
  })
  first.unmount()
  expect(canceled).toEqual([])
  second.rerender({ enabled: false })
  const firstRequest = vi.mocked(api.generate).mock.calls[0]![0]
  expect(canceled).toEqual([firstRequest.requestId])
  second.rerender({ enabled: true })
  await act(async () => abandoned.resolve({ success: true, svg: '<svg id="obsolete"/>' }))
  expect(second.result.current).toBeNull()
  await act(async () => renewed.resolve({ success: true, svg: '<svg/>' }))
  expect(second.result.current).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E')
})
