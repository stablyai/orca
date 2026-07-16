import type { Page } from '@stablyai/playwright-test'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect } from './helpers/orca-app'

export type LineageScenario = {
  parentId: string
  childId: string
}

export type CrossRepoParentPickerScenario = LineageScenario & {
  parentName: string
  parentRepoName: string
  repoPath: string
}

type RegisterPostElectronShutdownCleanup = (cleanup: () => Promise<void>) => void

async function removeCrossRepoParentPickerRepoFromDisk(repoPath: string): Promise<void> {
  await rm(repoPath, {
    force: true,
    maxRetries: 5,
    recursive: true,
    retryDelay: 250
  })
}

function createCrossRepoParentPickerRepo(
  registerPostElectronShutdownCleanup: RegisterPostElectronShutdownCleanup
): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'orca-e2e-cross-repo-parent-'))
  // Why: register immediately so even Git seeding failures clean up, but only
  // after Electron and its watchers have released the repository on Windows.
  registerPostElectronShutdownCleanup(() => removeCrossRepoParentPickerRepoFromDisk(repoPath))
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# Cross-repo parent picker E2E\n')
  execFileSync(
    'git',
    ['-c', 'user.name=Orca E2E', '-c', 'user.email=orca-e2e@example.com', 'add', 'README.md'],
    { cwd: repoPath }
  )
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Orca E2E',
      '-c',
      'user.email=orca-e2e@example.com',
      'commit',
      '-m',
      'initial commit'
    ],
    { cwd: repoPath }
  )
  return repoPath
}

export async function removeCrossRepoParentPickerRepo(page: Page, repoPath: string): Promise<void> {
  await page.evaluate(async (path) => {
    const store = window.__store
    const repo = store?.getState().repos.find((candidate) => candidate.path === path)
    if (repo) {
      const state = store.getState()
      const removedWorktreeIds = new Set(
        (state.worktreesByRepo[repo.id] ?? []).map((worktree) => worktree.id)
      )
      const orphanedChildIds = Object.entries(state.worktreeLineageById)
        .filter(([, lineage]) => removedWorktreeIds.has(lineage.parentWorktreeId))
        .map(([childId]) => childId)
      for (const childId of orphanedChildIds) {
        await store.getState().updateWorktreeLineage(childId, { noParent: true })
      }
      await store?.getState().removeProject(repo.id)
    }
  }, repoPath)
}

export async function seedCrossRepoParentPickerScenario(
  page: Page,
  registerPostElectronShutdownCleanup: RegisterPostElectronShutdownCleanup
): Promise<CrossRepoParentPickerScenario> {
  const repoPath = createCrossRepoParentPickerRepo(registerPostElectronShutdownCleanup)
  try {
    const repoId = await page.evaluate(async (path) => {
      const result = await window.api.repos.add({ path })
      if ('error' in result) {
        throw new Error(result.error)
      }
      return result.repo.id
    }, repoPath)

    let scenario: Omit<CrossRepoParentPickerScenario, 'repoPath'> | null = null
    await expect
      .poll(
        async () => {
          scenario = await page.evaluate(async (repoId) => {
            const store = window.__store
            if (!store) {
              return null
            }
            await store.getState().fetchRepos()
            const parentRepo = store.getState().repos.find((repo) => repo.id === repoId)
            if (!parentRepo) {
              return null
            }
            await store.getState().fetchWorktrees(repoId)
            const next = store.getState()
            const parent = next.worktreesByRepo[repoId]?.find((worktree) => !worktree.isArchived)
            const child = Object.entries(next.worktreesByRepo)
              .filter(([candidateRepoId]) => candidateRepoId !== repoId)
              .flatMap(([, worktrees]) => worktrees)
              .find((worktree) => !worktree.isArchived)
            if (!parent?.instanceId || !child?.instanceId) {
              return null
            }

            next.setActiveView('terminal')
            next.setSidebarOpen(true)
            next.setGroupBy('none')
            next.setSortBy('recent')
            next.setShowActiveOnly(false)
            next.setShowSleepingWorkspaces(true)
            next.setHideDefaultBranchWorkspace(false)
            next.setFilterRepoIds([])
            next.setActiveWorktree(child.id)

            return {
              childId: child.id,
              parentId: parent.id,
              parentName: parent.displayName,
              parentRepoName: parentRepo.displayName
            }
          }, repoId)
          return scenario
        },
        {
          timeout: 30_000,
          message: 'Cross-repo parent picker E2E repo did not load into the renderer'
        }
      )
      .not.toBeNull()

    if (!scenario) {
      throw new Error('Cross-repo parent picker E2E scenario did not resolve')
    }
    return { ...scenario, repoPath }
  } catch (error) {
    await removeCrossRepoParentPickerRepo(page, repoPath)
    throw error
  }
}

export async function seedLineageScenario(page: Page): Promise<LineageScenario> {
  return page.evaluate(() => {
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
    store.setState((current) => ({
      worktreesByRepo: Object.fromEntries(
        Object.entries(current.worktreesByRepo).map(([repoId, repoWorktrees]) => [
          repoId,
          repoWorktrees.map((worktree) => {
            if (worktree.id === parent.id) {
              return { ...worktree, displayName: 'E2E lineage parent', sortOrder: 0 }
            }
            if (worktree.id === child.id) {
              return { ...worktree, displayName: 'E2E lineage child', sortOrder: 1 }
            }
            return worktree
          })
        ])
      ),
      worktreeLineageById: {
        ...current.worktreeLineageById,
        [child.id]: {
          worktreeId: child.id,
          worktreeInstanceId: child.instanceId,
          parentWorktreeId: parent.id,
          parentWorktreeInstanceId: parent.instanceId,
          origin: 'manual',
          capture: { source: 'manual-action', confidence: 'explicit' },
          createdAt: Date.now()
        }
      }
    }))

    store.getState().setActiveWorktree(parent.id)
    return { parentId: parent.id, childId: child.id }
  })
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
