// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ActivityBarItem } from './activity-bar-buttons'
import { useRightSidebarTabRouting } from './use-right-sidebar-tab-routing'

const store = vi.hoisted(() => ({
  state: {
    rightSidebarTab: 'source-control',
    rightSidebarRouteRequestId: 0,
    setRightSidebarTab: () => {},
    showRightSidebarFiles: () => {},
    setRightSidebarEffectiveTab: (_tab: string | null) => {}
  }
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) => selector(store.state)
}))
vi.mock('./use-installed-plugin-route-reconciliation', () => ({
  useInstalledPluginRouteReconciliation: () => {}
}))

afterEach(cleanup)

it('publishes Explorer when it renders as the fallback for a hidden stored tab', () => {
  const published: (string | null)[] = []
  store.state.setRightSidebarEffectiveTab = (tab) => published.push(tab)
  // A folder repo hides the git-only Source Control tab.
  const visibleItems: ActivityBarItem[] = (['explorer', 'vault'] as const).map((id) => ({
    id,
    icon: () => null,
    title: id,
    shortcut: ''
  }))
  const { result, unmount } = renderHook(() =>
    useRightSidebarTabRouting({
      visibleItems,
      activeFolderWorkspaceKey: null,
      pluginSystemEnabled: false,
      pluginFetchStatus: 'idle',
      installedPluginTabKeys: new Set()
    })
  )
  expect(result.current.effectiveTab).toBe('explorer')
  expect(published).toEqual(['explorer'])
  unmount()
  expect(published).toEqual(['explorer', null])
})
