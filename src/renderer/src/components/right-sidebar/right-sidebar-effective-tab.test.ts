import { describe, expect, it } from 'vitest'
import type { ActiveRightSidebarTab } from '@/store/slices/editor'
import { resolveRightSidebarEffectiveTab } from './right-sidebar-effective-tab'

const folderVisibleItems = [
  { id: 'explorer' },
  { id: 'vault' },
  { id: 'workspaces' },
  { id: 'pr-checks' }
] satisfies { id: ActiveRightSidebarTab }[]

const gitVisibleItems = [
  { id: 'explorer' },
  { id: 'vault' },
  { id: 'source-control' },
  { id: 'checks' }
] satisfies { id: ActiveRightSidebarTab }[]

describe('resolveRightSidebarEffectiveTab', () => {
  it('lets remembered folder PR Checks win over a visible global Explorer route', () => {
    expect(
      resolveRightSidebarEffectiveTab({
        normalizedActiveTab: 'explorer',
        visibleItems: folderVisibleItems,
        activeFolderWorkspaceKey: 'folder:folder-1',
        rememberedFolderTab: 'pr-checks'
      })
    ).toBe('pr-checks')
  })

  it('lets an explicit remembered folder Explorer selection win over another visible route', () => {
    expect(
      resolveRightSidebarEffectiveTab({
        normalizedActiveTab: 'pr-checks',
        visibleItems: folderVisibleItems,
        activeFolderWorkspaceKey: 'folder:folder-1',
        rememberedFolderTab: 'explorer'
      })
    ).toBe('explorer')
  })

  it('ignores folder memory outside active folder workspace roots', () => {
    expect(
      resolveRightSidebarEffectiveTab({
        normalizedActiveTab: 'explorer',
        visibleItems: gitVisibleItems,
        activeFolderWorkspaceKey: null,
        rememberedFolderTab: 'pr-checks'
      })
    ).toBe('explorer')
  })

  it('falls through to the global route when folder memory is stale or hidden', () => {
    expect(
      resolveRightSidebarEffectiveTab({
        normalizedActiveTab: 'workspaces',
        visibleItems: folderVisibleItems,
        activeFolderWorkspaceKey: 'folder:folder-1',
        rememberedFolderTab: 'checks'
      })
    ).toBe('workspaces')
  })

  it('falls back to the first visible item when the global route is hidden', () => {
    expect(
      resolveRightSidebarEffectiveTab({
        normalizedActiveTab: 'pr-checks',
        visibleItems: gitVisibleItems,
        activeFolderWorkspaceKey: null,
        rememberedFolderTab: null
      })
    ).toBe('explorer')
  })

  it('keeps a plugin tab active while its panel is still contributed', () => {
    expect(
      resolveRightSidebarEffectiveTab({
        normalizedActiveTab: 'plugin:orca-samples.my-plugin/dashboard',
        visibleItems: [...gitVisibleItems, { id: 'plugin:orca-samples.my-plugin/dashboard' }],
        activeFolderWorkspaceKey: null,
        rememberedFolderTab: null
      })
    ).toBe('plugin:orca-samples.my-plugin/dashboard')
  })

  it('falls back to the first visible item when a plugin tab was uninstalled', () => {
    expect(
      resolveRightSidebarEffectiveTab({
        normalizedActiveTab: 'plugin:orca-samples.my-plugin/dashboard',
        visibleItems: gitVisibleItems,
        activeFolderWorkspaceKey: null,
        rememberedFolderTab: null
      })
    ).toBe('explorer')
  })

  it('treats empty visible items as an invariant failure', () => {
    expect(() =>
      resolveRightSidebarEffectiveTab({
        normalizedActiveTab: 'explorer',
        visibleItems: [],
        activeFolderWorkspaceKey: null,
        rememberedFolderTab: null
      })
    ).toThrow('at least one visible tab')
  })
})
