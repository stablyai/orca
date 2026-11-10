// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorktreeIconsApi } from '../../../../preload/api/worktree-icons-bridge'
import type { WorktreeIconGenerationResult } from '../../../../shared/worktree/worktree-icon-generation'
import {
  regenerateWorktreeAiIcons,
  retryFailedWorktreeAiIcons,
  useWorktreeAiIcon
} from './use-worktree-ai-icon'

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
    },
    clearCache: async () => {}
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

it('regenerates a pending icon and ignores results from the previous recipe', async () => {
  const old = Promise.withResolvers<WorktreeIconGenerationResult>()
  const fresh = Promise.withResolvers<WorktreeIconGenerationResult>()
  vi.stubGlobal('api', {
    worktreeIcons: {
      generate: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise),
      cancel: async () => {},
      clearCache: async () => {}
    }
  })
  const hook = renderHook(() => useWorktreeAiIcon('regenerated icon', true))
  await act(() => regenerateWorktreeAiIcons())
  await act(async () => fresh.resolve({ success: true, svg: '<svg/>' }))
  await act(async () => old.resolve({ success: true, svg: '<svg id="obsolete"/>' }))
  expect(hook.result.current).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E')
})

it('evicts unused successes and failures while retaining mounted and recently used icons', async () => {
  const generate = vi.fn(async ({ name }: { name: string }) =>
    name === 'old failure'
      ? { success: false, error: 'unavailable' }
      : { success: true, svg: '<svg/>' }
  )
  vi.stubGlobal('api', { worktreeIcons: { generate, cancel: async () => {} } })
  for (const name of ['old success', 'old failure']) {
    const hook = renderHook(() => useWorktreeAiIcon(name, true))
    await act(async () => {})
    hook.unmount()
  }
  const mounted = renderHook(() => useWorktreeAiIcon('kept mounted', true))
  for (let index = 0; index < 600; index++) {
    const hook = renderHook(() => useWorktreeAiIcon(`unused icon ${index}`, true))
    await act(async () => {})
    hook.unmount()
  }
  expect(mounted.result.current).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E')
  const recent = renderHook(() => useWorktreeAiIcon('unused icon 599', true))
  expect(recent.result.current).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%2F%3E')
  generate.mockResolvedValue({ success: true, svg: '<svg id="new"/>' })
  for (const name of ['old success', 'old failure']) {
    const hook = renderHook(() => useWorktreeAiIcon(name, true))
    await act(async () => {})
    expect(hook.result.current).toBe(
      'data:image/svg+xml;charset=utf-8,%3Csvg%20id%3D%22new%22%2F%3E'
    )
    hook.unmount()
  }
})
