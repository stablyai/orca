// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useResourceViewVisible } from '../components/status-bar/use-resource-view-visible'
import { installWebPreloadApi } from './web-preload-api'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('admits browser Resources while visible and parks it with the document', async () => {
  vi.stubGlobal('api', undefined)
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  installWebPreloadApi()
  const { result } = renderHook(useResourceViewVisible)
  await act(async () => {})
  expect(result.current).toBe(true)

  act(() => {
    visibility.mockReturnValue('hidden')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(result.current).toBe(false)

  act(() => {
    visibility.mockReturnValue('visible')
    document.dispatchEvent(new Event('visibilitychange'))
  })
  expect(result.current).toBe(true)
})
