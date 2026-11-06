// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { useAiVaultSearchFocusRequest } from './use-ai-vault-search-focus-request'

afterEach(() => {
  cleanup()
  useAppStore.getState().clearAiVaultSearchFocusRequest()
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
