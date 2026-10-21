// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useAiVaultSearchFocusRequest } from './use-ai-vault-search-focus-request'

afterEach(() => {
  cleanup()
  useAppStore.getState().clearAiVaultSearchFocusRequest()
})

it('opens the sidebar on the session panel when Settings asks for it', () => {
  act(() => {
    useAppStore.getState().showAiVaultSearch()
  })
  const state = useAppStore.getState()
  expect(state.rightSidebarOpen).toBe(true)
  expect(state.rightSidebarTab).toBe('vault')
  expect(state.aiVaultSearchFocusRequested).toBe(true)
})

it('runs the request once and clears it so a remount stays put', () => {
  const onRequest = vi.fn()
  const view = renderHook(() => useAiVaultSearchFocusRequest(onRequest))
  expect(onRequest).not.toHaveBeenCalled()
  act(() => {
    useAppStore.getState().showAiVaultSearch()
  })
  expect(onRequest).toHaveBeenCalledOnce()
  expect(useAppStore.getState().aiVaultSearchFocusRequested).toBe(false)

  view.unmount()
  renderHook(() => useAiVaultSearchFocusRequest(onRequest))
  expect(onRequest).toHaveBeenCalledOnce()
})
