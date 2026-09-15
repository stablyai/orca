// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useRightSidebarActivityItems } from './use-right-sidebar-activity-items'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

type TestState = {
  activeWorktreeId: string | null
  getKnownWorktreeById: () => null
  settings: { pluginSystemEnabled?: boolean } | null
}

const testState: TestState = {
  activeWorktreeId: null,
  getKnownWorktreeById: () => null,
  settings: null
}

type PluginPanelsStore = { plugins: []; fetchStatus: 'ready'; panelErrors: {} }

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: typeof testState) => unknown) => selector(testState)
}))

vi.mock('@/store/selectors', () => ({
  useRepoById: () => null
}))

vi.mock('@/store/plugin-panels', () => ({
  collectInstalledPluginTabKeys: () => new Set(),
  usePluginPanels: () => [],
  usePluginPanelsStore: (selector: (state: PluginPanelsStore) => unknown) =>
    selector({ plugins: [], fetchStatus: 'ready', panelErrors: {} })
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => 'Unassigned'
}))

afterEach(async () => {
  await act(async () => undefined)
  document.body.innerHTML = ''
})

describe('useRightSidebarActivityItems', () => {
  it('exposes Notes in the activity bar', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    let visibleItemIds: string[] = []

    function Harness(): null {
      visibleItemIds = useRightSidebarActivityItems({ rightSidebarOpen: true }).visibleItems.map(
        (item) => item.id
      )
      return null
    }

    await act(async () => root.render(<Harness />))

    expect(visibleItemIds).toEqual(['explorer', 'vault', 'notes', 'source-control', 'checks'])

    await act(async () => root.unmount())
  })
})
