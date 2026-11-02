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

it('runs the request once and clears it so a remount stays put', () => {
  const onRequest = vi.fn()
  const view = renderHook(() => useAiVaultSearchFocusRequest(onRequest))
  expect(onRequest).not.toHaveBeenCalled()
  act(() => {
    useAppStore.getState().showAiVaultSearch()
  })
  expect(onRequest).toHaveBeenCalledExactlyOnceWith(false)
  expect(useAppStore.getState().aiVaultSearchFocusRequested).toBe(false)

  view.unmount()
  renderHook(() => useAiVaultSearchFocusRequest(onRequest))
  expect(onRequest).toHaveBeenCalledOnce()
})

it('tells the panel to keep its scope when the request asks for that', () => {
  const onRequest = vi.fn()
  renderHook(() => useAiVaultSearchFocusRequest(onRequest))
  act(() => {
    useAppStore.getState().showAiVaultSearchKeepingScope()
  })
  expect(onRequest).toHaveBeenCalledExactlyOnceWith(true)
  expect(useAppStore.getState().aiVaultSearchKeepScope).toBe(false)
})
