import type { Page } from '@stablyai/playwright-test'

export type LineageScenario = {
  parentId: string
  childId: string
}

export async function seedLineageScenario(
  page: Page,
  options: { inlineOnly?: boolean } = {}
): Promise<LineageScenario> {
  return page.evaluate(({ inlineOnly }) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    state.setActiveView('terminal')
    state.setSidebarOpen(true)
    state.setGroupBy('none')
    state.setSortBy('recent')
    // Why: these specs assert lineage structure, not the user's persisted
    // sidebar filters. Make the seeded child render even when it has no live PTY.
    state.setShowActiveOnly(false)
    state.setShowSleepingWorkspaces(true)
    state.setHideDefaultBranchWorkspace(false)
    state.setFilterRepoIds([])

    const worktrees = Object.values(state.worktreesByRepo)
      .flat()
      .filter((worktree) => !worktree.isArchived)
    if (worktrees.length < 2) {
      throw new Error('Worktree lineage E2E needs at least two worktrees')
    }

    const [parent, child] = worktrees
    if (!parent.instanceId || !child.instanceId) {
      throw new Error('Worktree lineage E2E needs instance-stamped worktrees')
    }
    const lineage = {
      worktreeId: child.id,
      worktreeInstanceId: child.instanceId,
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: parent.instanceId,
      origin: 'manual' as const,
      capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
      createdAt: Date.now()
    }
    store.setState((current) => ({
      worktreesByRepo: Object.fromEntries(
        Object.entries(current.worktreesByRepo).map(([repoId, repoWorktrees]) => [
          repoId,
          repoWorktrees.map((worktree) => {
            if (worktree.id === parent.id) {
              return {
                ...worktree,
                displayName: 'E2E lineage parent',
                sortOrder: 0,
                ...(inlineOnly
                  ? { parentWorktreeId: null, childWorktreeIds: [child.id], lineage: null }
                  : {})
              }
            }
            if (worktree.id === child.id) {
              return {
                ...worktree,
                displayName: 'E2E lineage child',
                sortOrder: 1,
                ...(inlineOnly
                  ? { parentWorktreeId: parent.id, childWorktreeIds: [], lineage }
                  : {})
              }
            }
            return worktree
          })
        ])
      ),
      worktreeLineageById: inlineOnly ? {} : { ...current.worktreeLineageById, [child.id]: lineage }
    }))

    store.getState().setActiveWorktree(parent.id)
    return { parentId: parent.id, childId: child.id }
  }, options)
}

export async function seedWorkspaceAgentStatus(
  page: Page,
  worktreeId: string,
  label: string
): Promise<string> {
  return page.evaluate(
    ({ worktreeId, label }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }

      const state = store.getState()
      if (!state.worktreeCardProperties.includes('inline-agents')) {
        state.toggleWorktreeCardProperty('inline-agents')
      }
      if ((state.tabsByWorktree[worktreeId] ?? []).length === 0) {
        state.createTab(worktreeId)
      }

      const next = store.getState()
      const tab = next.tabsByWorktree[worktreeId]?.[0]
      if (!tab) {
        throw new Error(`Worktree lineage E2E failed to create a ${label} workspace tab`)
      }

      const prompt = `LINEAGE_${label}_AGENT_${Date.now()}`
      const leafId = crypto.randomUUID()
      const now = Date.now()
      next.setAgentStatus(
        `${tab.id}:${leafId}`,
        { state: 'working', prompt, agentType: 'codex' },
        'codex',
        { updatedAt: now, stateStartedAt: now }
      )
      return prompt
    },
    { worktreeId, label }
  )
}

export async function seedWorkspaceLiveTerminal(page: Page, worktreeId: string): Promise<string> {
  return page.evaluate((worktreeId) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    const state = store.getState()
    if ((state.tabsByWorktree[worktreeId] ?? []).length === 0) {
      state.createTab(worktreeId)
    }

    const next = store.getState()
    const tab = next.tabsByWorktree[worktreeId]?.[0]
    if (!tab) {
      throw new Error('Worktree lineage E2E failed to create a live terminal tab')
    }

    next.dropAgentStatusByWorktree(worktreeId)
    store.setState((current) => ({
      ptyIdsByTabId: {
        ...current.ptyIdsByTabId,
        [tab.id]: [`e2e-live-pty-${Date.now()}`]
      },
      browserTabsByWorktree: {
        ...current.browserTabsByWorktree,
        [worktreeId]: []
      }
    }))
    return tab.id
  }, worktreeId)
}

export async function markWorkspaceTerminalSlept(
  page: Page,
  args: { worktreeId: string; tabId: string }
): Promise<void> {
  await page.evaluate(({ worktreeId, tabId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }

    store.getState().dropAgentStatusByWorktree(worktreeId)
    store.setState((current) => ({
      ptyIdsByTabId: {
        ...current.ptyIdsByTabId,
        [tabId]: []
      },
      browserTabsByWorktree: {
        ...current.browserTabsByWorktree,
        [worktreeId]: []
      }
    }))
  }, args)
}
