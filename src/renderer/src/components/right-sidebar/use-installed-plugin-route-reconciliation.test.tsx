// @vitest-environment happy-dom

import { createRoot } from 'react-dom/client'
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PluginPanelsFetchStatus } from '@/store/plugin-panels'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import { useInstalledPluginRouteReconciliation } from './use-installed-plugin-route-reconciliation'

const roots: ReturnType<typeof createRoot>[] = []

afterEach(async () => {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount()
    }
  })
  document.body.innerHTML = ''
})

describe('useInstalledPluginRouteReconciliation', () => {
  it('waits through loading, then persists Explorer for a proven-uninstalled panel', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const setStoredTab = vi.fn()
    const storedTab = 'plugin:orca-samples.removed/dashboard' as const
    const Harness = ({ fetchStatus }: { fetchStatus: PluginPanelsFetchStatus }) => {
      useInstalledPluginRouteReconciliation({
        pluginSystemEnabled: true,
        fetchStatus,
        storedTab,
        normalizedTab: 'explorer',
        setStoredTab
      })
      return null
    }

    await act(async () => root.render(<Harness fetchStatus="loading" />))
    expect(setStoredTab).not.toHaveBeenCalled()

    await act(async () => root.render(<Harness fetchStatus="ready" />))
    expect(setStoredTab).toHaveBeenCalledOnce()
    expect(setStoredTab).toHaveBeenCalledWith('explorer' satisfies ActiveRightSidebarTab)
  })

  it('does not rewrite a still-installed plugin route', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const setStoredTab = vi.fn()
    const storedTab = 'plugin:orca-samples.present/dashboard' as const
    const Harness = () => {
      useInstalledPluginRouteReconciliation({
        pluginSystemEnabled: true,
        fetchStatus: 'ready',
        storedTab,
        normalizedTab: storedTab,
        setStoredTab
      })
      return null
    }

    await act(async () => root.render(<Harness />))
    expect(setStoredTab).not.toHaveBeenCalled()
  })

  it('preserves an installed route while the global plugin feature is disabled', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    roots.push(root)
    const setStoredTab = vi.fn()
    const storedTab = 'plugin:orca-samples.present/dashboard' as const
    const Harness = () => {
      useInstalledPluginRouteReconciliation({
        pluginSystemEnabled: false,
        fetchStatus: 'ready',
        storedTab,
        normalizedTab: 'explorer',
        setStoredTab
      })
      return null
    }

    await act(async () => root.render(<Harness />))
    expect(setStoredTab).not.toHaveBeenCalled()
  })
})
