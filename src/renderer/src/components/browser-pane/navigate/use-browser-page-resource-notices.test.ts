// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  browserSessionImportState: {
    status: 'success',
    summary: {
      totalCookies: 2,
      importedCookies: 1,
      skippedCookies: 1,
      domains: ['good.example']
    }
  },
  clearBrowserSessionImportState: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: (select: (value: typeof state) => unknown) => select(state)
}))

import { useBrowserPageResourceNotices } from './use-browser-page-resource-notices'

afterEach(cleanup)

it('names only the successful summary domains in the import notice', () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      browser: {
        onPermissionDenied: () => () => {},
        onPopup: () => () => {}
      }
    }
  })

  const { result } = renderHook(() => useBrowserPageResourceNotices('browser-1'))

  expect(result.current.resourceNotice).toBe(
    'Imported 1 cookies for good.example. Reload the page to use them.'
  )
  expect(state.clearBrowserSessionImportState).toHaveBeenCalledOnce()
})
