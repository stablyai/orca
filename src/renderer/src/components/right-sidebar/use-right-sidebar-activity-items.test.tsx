import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Server } from 'lucide-react'
import { useRightSidebarActivityItems } from './use-right-sidebar-activity-items'

const state = vi.hoisted(() => ({
  activeWorktreeId: 'repo::/app',
  settings: { pluginSystemEnabled: false },
  runtimeEnvironments: [],
  getKnownWorktreeById: () => ({ repoId: 'repo' }),
  sshHost: false
}))
vi.mock('@/store', () => ({
  useAppStore: (selector: (value: unknown) => unknown) => selector(state)
}))
vi.mock('@/store/selectors', () => ({ useRepoById: () => ({ id: 'repo', kind: 'git' }) }))
vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Unassigned' }))
vi.mock('@/store/plugin-panels', () => ({
  usePluginPanels: () => [],
  usePluginPanelsStore: (selector: (value: unknown) => unknown) =>
    selector({ plugins: [], fetchStatus: 'idle', panelErrors: {} }),
  collectInstalledPluginTabKeys: () => new Set()
}))
vi.mock('./ports-panel-host', () => ({
  getPortsPanelOwnerKey: () => 'local',
  portsPanelHostForOwnerKey: () => ({ kind: 'endpoint' }),
  portsPanelReachesSshHost: () => state.sshHost
}))

function ActivityProbe() {
  const { visibleItems } = useRightSidebarActivityItems({ rightSidebarOpen: true })
  const servers = visibleItems.find((item) => item.id === 'ports')
  return servers ? <span data-server-icon={servers.icon === Server}>{servers.title}</span> : null
}

beforeEach(() => {
  state.activeWorktreeId = 'repo::/app'
  state.sshHost = false
})

describe('Servers activity tab', () => {
  it('is available for local workspaces with the Server icon', () => {
    expect(renderToStaticMarkup(<ActivityProbe />)).toContain('data-server-icon="true">Servers')
  })

  it('keeps the same tab available on SSH workspaces', () => {
    state.sshHost = true
    expect(renderToStaticMarkup(<ActivityProbe />)).toContain('Servers')
  })

  it('remains reachable before selecting a workspace so the panel can show its empty state', () => {
    state.activeWorktreeId = ''
    expect(renderToStaticMarkup(<ActivityProbe />)).toContain('Servers')
  })
})
