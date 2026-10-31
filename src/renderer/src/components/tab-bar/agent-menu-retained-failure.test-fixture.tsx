import { act, renderHook } from '@testing-library/react'
import { expect, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useAgentMenuObservation } from './use-new-tab-agent-menu-rows'
import type { UseDetectedAgentsResult } from '@/hooks/useDetectedAgents'

export async function exerciseAgentMenuRetainedFailure(
  setDetection: (value: Omit<UseDetectedAgentsResult, 'refresh'>) => void
): Promise<void> {
  useAppStore.getState().clearRemoteDetectedAgents('current-f25')
  useAppStore.getState().clearRemoteDetectedAgents('other-f25')
  useAppStore.setState({ remoteDetectedAgentIds: { 'current-f25': [] } })
  Object.assign(window, {
    api: {
      ...window.api,
      preflight: {
        ...window.api?.preflight,
        detectRemoteAgents: vi.fn().mockRejectedValue(new Error('keyed failed attempt'))
      }
    }
  })
  setDetection({
    detectedIds: [],
    detectionFailed: false,
    isLoading: false,
    isRefreshing: false,
    needsServerUpdate: false
  })
  let renders = 0
  const hook = renderHook(() => {
    renders++
    return useAgentMenuObservation(
      { workspace: { kind: 'git-worktree', executionHostId: 'ssh:current-f25' } },
      true,
      { kind: 'ssh', connectionId: 'current-f25' },
      true
    )
  })
  await act(async () => {})
  const before = renders
  await act(() => useAppStore.getState().ensureRemoteDetectedAgents('other-f25', { force: true }))
  expect(renders).toBe(before)
  await act(() => useAppStore.getState().ensureRemoteDetectedAgents('current-f25', { force: true }))
  expect(hook.result.current.failedAttempt).toBe(true)
  expect(renders).toBeGreaterThan(before)
  const held = Promise.withResolvers<string[]>()
  window.api.preflight.detectRemoteAgents = vi.fn(() => held.promise)
  let pending = Promise.resolve<string[]>([])
  act(() => {
    pending = useAppStore.getState().ensureRemoteDetectedAgents('current-f25', { force: true })
  })
  expect(hook.result.current.failedAttempt).toBe(false)
  await act(async () => {
    held.resolve([])
    await pending
  })
  expect(hook.result.current.failedAttempt).toBe(false)
}
