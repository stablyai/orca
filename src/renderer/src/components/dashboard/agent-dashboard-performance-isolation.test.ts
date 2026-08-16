import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const rendererRoot = join(__dirname, '../..')

function source(relativePath: string): string {
  return readFileSync(join(rendererRoot, relativePath), 'utf8')
}

describe('agent dashboard performance isolation', () => {
  it('keeps all dashboard feature modules out of the disabled app and sidebar path', () => {
    const backgroundServices = source('app-shell/AppBackgroundServices.tsx')
    const sidebar = source('components/sidebar/index.tsx')
    const nav = source('components/sidebar/SidebarNav.tsx')

    expect(backgroundServices).not.toMatch(/from ['"].*DashboardPopoutBridge['"]/)
    expect(backgroundServices).toContain("import('../components/dashboard/DashboardPopoutBridge')")
    expect(sidebar).not.toMatch(/from ['"].*AgentDashboard(?:Drawer|SidebarHost)['"]/)
    expect(sidebar).toContain("import('./AgentDashboardSidebarHost')")
    expect(nav).not.toContain('useAgentBucketCounts')
    expect(nav).not.toContain('shared/dashboard-snapshot')
    expect(nav).toContain("import('./AgentDashboardSidebarEntry')")
  })

  it('keeps map computation out of the main-renderer drawer', () => {
    const board = source('components/dashboard-popout/AgentKanbanBoard.tsx')
    const drawer = source('components/dashboard/AgentDashboardDrawer.tsx')
    const toolbar = source('components/dashboard-popout/AgentDashboardToolbar.tsx')

    expect(board).toContain("import('./AgentDashboardMapView')")
    expect(board).not.toMatch(/from ['"].\/(?:AgentMap|useAgentMap|agent-map-)/)
    expect(toolbar).not.toMatch(/from ['"].\/(?:AgentMap|useAgentMap|agent-map-)/)
    expect(drawer).toContain('initialView="board"')
    expect(drawer).toContain("openPopout?.('map')")
    expect(drawer).toContain('onOpenMap={handleOpenMap}')
  })
})
