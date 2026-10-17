// @vitest-environment happy-dom

import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { Bug } from 'lucide-react'
import { normalizeRightSidebarRoute } from '@/store/right-sidebar-route'
import { normalizeRightSidebarTab } from '../../../../main/persistence/applying-settings/ui-selection-normalization'
import {
  RightSidebarTabParam,
  STATIC_RIGHT_SIDEBAR_TABS
} from '../../../../shared/rpc-contract/client-ui-params'
import type { RightSidebarActivityItems } from '../right-sidebar/use-right-sidebar-activity-items'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => 'Unassigned'
}))

vi.mock('@/store', () => ({
  useAppStore: (select: (state: unknown) => unknown) =>
    select({
      activeWorktreeId: null,
      getKnownWorktreeById: () => null,
      settings: { pluginSystemEnabled: false }
    })
}))

vi.mock('@/store/selectors', () => ({
  useRepoById: () => null
}))

vi.mock('@/store/plugin-panels', () => ({
  collectInstalledPluginTabKeys: () => new Set<string>(),
  usePluginPanels: () => [],
  usePluginPanelsStore: (select: (state: unknown) => unknown) =>
    select({ plugins: [], fetchStatus: 'idle', panelErrors: {} })
}))

const { useRightSidebarActivityItems } =
  await import('../right-sidebar/use-right-sidebar-activity-items')

describe('debug right-sidebar tab routing', () => {
  it('survives the renderer route normalizer', () => {
    expect(normalizeRightSidebarRoute('debug')).toEqual({
      rightSidebarTab: 'debug',
      rightSidebarExplorerView: 'files'
    })
  })

  it('survives the persisted UI state normalizer', () => {
    expect(normalizeRightSidebarTab('debug')).toBe('debug')
  })

  it('is a static tab accepted by the client UI schema', () => {
    expect(STATIC_RIGHT_SIDEBAR_TABS).toContain('debug')
    expect(RightSidebarTabParam.safeParse('debug').success).toBe(true)
  })

  it('appears in the activity items with no git, folder or SSH gate', async () => {
    const results: RightSidebarActivityItems[] = []
    function Probe(): null {
      results.push(useRightSidebarActivityItems({ rightSidebarOpen: true }))
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(createElement(Probe))
    })

    const debug = results.at(-1)?.visibleItems.find((item) => item.id === 'debug')
    expect(debug?.title).toBe('Run and Debug')
    expect(debug?.icon).toBe(Bug)
    expect(debug?.gitOnly).toBeFalsy()
    expect(debug?.folderOnly).toBeFalsy()
    expect(debug?.sshOnly).toBeFalsy()

    await act(async () => {
      root.unmount()
    })
  })
})
