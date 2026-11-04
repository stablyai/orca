// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

const rootNavigation = vi.hoisted(() => ({
  backToWorkspace: vi.fn(),
  browsedRootPath: '/tmp/reference',
  goUp: vi.fn(),
  navigateToPath: vi.fn(),
  openFolder: vi.fn(),
  returnRoot: null,
  revealOutsideRoot: vi.fn(),
  selectRoot: vi.fn()
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(
    vi.fn((selector) => selector({})),
    {
      getState: vi.fn(() => ({
        clearPendingExplorerReveal: vi.fn(),
        setExplorerDisplayRootForWorktree: vi.fn()
      }))
    }
  )
}))
vi.mock('./file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwnerFromState: () => ({
    kind: 'runtime',
    environmentId: 'remote',
    executionHostId: 'runtime:remote'
  }),
  supportsFileExplorerRootNavigation: () => false
}))
vi.mock('./use-file-explorer-root-navigation', () => ({
  useFileExplorerRootNavigation: () => rootNavigation
}))

import { useFileExplorerDisplayRootState } from './use-file-explorer-display-root-state'

it('ignores a local browsed root for a remote-runtime workspace', () => {
  const { result } = renderHook(() =>
    useFileExplorerDisplayRootState('wt', { path: '/remote/repo' })
  )

  expect(result.current.displayRootPath).toBe('/remote/repo')
  expect(result.current.outsideWorkspace).toBe(false)
  expect(result.current.navigation?.breadcrumbs.at(-1)?.path).toBe('/remote/repo')
})
