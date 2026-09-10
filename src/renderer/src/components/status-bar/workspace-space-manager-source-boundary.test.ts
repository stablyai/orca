import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const COMPONENT_ROOT = __dirname
const PRODUCTION_MODULES = [
  'WorkspaceSpaceManagerPanel.tsx',
  'use-workspace-space-decision-projection.ts',
  'use-workspace-space-git-refresh-action.ts',
  'use-workspace-space-manager-bindings.ts',
  'use-workspace-space-manager-panel.ts',
  'use-workspace-space-manager-projection.ts',
  'workspace-space-breakdown-list.tsx',
  'workspace-space-decision-details.ts',
  'workspace-space-decision-hover-card.tsx',
  'workspace-space-manager-overview.tsx',
  'workspace-space-manager-state-types.ts',
  'workspace-space-manager-table.tsx',
  'workspace-space-manager-toolbar.tsx',
  'workspace-space-manager-view.tsx',
  'workspace-space-metrics.tsx',
  'workspace-space-selection-controls.tsx',
  'workspace-space-status-badge.tsx',
  'workspace-space-treemap.tsx',
  'workspace-space-worktree-row.tsx'
] as const

function source(relativePath: string): string {
  return readFileSync(join(COMPONENT_ROOT, relativePath), 'utf8').replace(/\r\n?/g, '\n')
}

describe('workspace space manager source boundaries', () => {
  it('keeps the public export path as a controller/view facade', () => {
    const facade = source('WorkspaceSpaceManagerPanel.tsx')

    expect(facade).toContain('useWorkspaceSpaceManagerPanel()')
    expect(facade).toContain('<WorkspaceSpaceManagerView model={model} />')
    expect(facade).toContain('export { getWorkspaceDecisionDetails }')
    expect(facade).not.toContain('max-lines')
  })

  it('keeps every production module below its physical line limit', () => {
    for (const moduleName of PRODUCTION_MODULES) {
      const moduleSource = source(moduleName)
      const limit = moduleName.endsWith('.tsx') ? 400 : 300

      expect(moduleSource.split('\n').length - 1, moduleName).toBeLessThan(limit)
      expect(moduleSource, moduleName).not.toContain('disable max-lines')
    }
  })

  it('preserves bounded git refreshes and source-owned runtime routing', () => {
    const action = source('use-workspace-space-git-refresh-action.ts')
    const projection = source('use-workspace-space-manager-projection.ts')

    expect(action).toContain('const currentState = useAppStore.getState()')
    expect(action).toContain('connectionId:')
    expect(action).toContain('getRuntimeGitStatus({')
    expect(action).toContain('getWorkspaceSpaceWorktreeIdentity(worktree)')
    expect(action).toContain('inFlightGitStatusRefreshes.current.delete(requestKey)')
    expect(projection).toContain('const GIT_STATUS_REFRESH_CONCURRENCY = 6')
    expect(projection).toContain('await refreshWorkspaceGitStatus(worktree)')
    expect(projection).toContain('void Promise.all(')
    expect(projection).toContain('cancelled = true')
  })

  it('preserves normal, force, and open-workspace action routing', () => {
    const controller = source('use-workspace-space-manager-panel.ts')
    const table = source('workspace-space-manager-table.tsx')

    expect(controller).toContain('runWorktreeBatchDelete(identities, {')
    expect(controller).toContain('forceConfirm: true')
    expect(controller).toContain('prepareActiveWorktreeFocusAfterDelete(worktree.worktreeId)')
    expect(controller).toContain(
      'removeWorktree(\n        { id: worktree.worktreeId, executionHostId: worktree.executionHostId ?? null },\n        true,\n        { allowUnverifiedPtyStop: true }\n      )'
    )
    expect(table).toContain('activateAndRevealWorktree(worktree.worktreeId)')
  })
})
