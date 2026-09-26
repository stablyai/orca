import type { Page } from '@stablyai/playwright-test'

export async function seedVirtualLineage(page: Page, newCardStyle: boolean) {
  return page.evaluate((newCardStyle) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const parent = worktrees[0]
    const template = worktrees[1]
    if (!parent?.instanceId || !template) {
      throw new Error('Lineage fixtures unavailable')
    }
    const rootInstanceId = parent.instanceId
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('manual')
    state.setShowActiveOnly(false)
    state.setShowSleepingWorkspaces(true)
    state.setHideDefaultBranchWorkspace(false)
    state.setFilterRepoIds([])
    state.setWorktreeCardProperties(['status', 'branch', 'inline-agents'])
    const children = Array.from({ length: 500 }, (_, index) => {
      const id = `e2e-virtual-child-${index}`
      const instanceId = `e2e-virtual-instance-${index}`
      const nestedParent = index === 400 || index === 401 ? index - 1 : null
      const parentWorktreeId =
        nestedParent === null ? parent.id : `e2e-virtual-child-${nestedParent}`
      const parentInstanceId =
        nestedParent === null ? rootInstanceId : `e2e-virtual-instance-${nestedParent}`
      return {
        ...template,
        id,
        instanceId,
        repoId: parent.repoId,
        hostId: parent.hostId,
        displayName: `Virtual child ${index}`,
        isPinned: false,
        isMainWorktree: false,
        sortOrder: 500 - index,
        parentWorktreeId,
        childWorktreeIds: [],
        lineage: {
          worktreeId: id,
          worktreeInstanceId: instanceId,
          parentWorktreeId,
          parentWorktreeInstanceId: parentInstanceId,
          origin: 'manual' as const,
          capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
          createdAt: 1
        }
      }
    })
    store.setState((current) => ({
      settings: current.settings
        ? { ...current.settings, experimentalNewWorktreeCardStyle: newCardStyle }
        : current.settings,
      worktreesByRepo: {
        [parent.repoId]: [
          { ...parent, displayName: 'Virtual lineage parent', isPinned: false, sortOrder: 0 },
          ...children
        ]
      },
      worktreeLineageById: Object.fromEntries(children.map((child) => [child.id, child.lineage])),
      collapsedGroups: new Set(),
      agentActivityDisplayMode: 'full'
    }))
    store.getState().setActiveWorktree(parent.id)
    return { parentId: parent.id, targetId: children[400]!.id }
  }, newCardStyle)
}
