import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

type LineageScenario = {
  parentId: string
  childId: string
}

function worktreeOption(page: Page, worktreeId: string) {
  return page.locator(`[id="worktree-list-option-${encodeURIComponent(worktreeId)}"]`)
}

async function seedLineageScenario(page: Page): Promise<LineageScenario> {
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
    state.setShowWorkspaceLineage(true)

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

async function seedWorkspaceAgentStatus(
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

test.describe('Worktree Lineage', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('renders existing child lineage in the sidebar', async ({ orcaPage }) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage)
    const parentRow = worktreeOption(orcaPage, parentId)
    const childRow = worktreeOption(orcaPage, childId)

    await expect(parentRow).toContainText('E2E lineage parent')
    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')

    await expect(childRow).toContainText('E2E lineage child')
    const childToggle = parentRow.getByRole('button', { name: 'Hide 1 child workspace' })
    await expect(childToggle).toBeVisible({ timeout: 10_000 })
    await expect(childRow).toBeVisible()

    const positions = await orcaPage.evaluate(
      ({ parentId, childId }) => {
        const parent = document.getElementById(
          `worktree-list-option-${encodeURIComponent(parentId)}`
        )
        const child = document.getElementById(`worktree-list-option-${encodeURIComponent(childId)}`)
        if (!parent || !child) {
          return null
        }
        return {
          parentTop: parent.getBoundingClientRect().top,
          childTop: child.getBoundingClientRect().top
        }
      },
      { parentId, childId }
    )
    expect(positions).not.toBeNull()
    expect(positions!.childTop).toBeGreaterThan(positions!.parentTop)

    await childToggle.click()
    await expect(parentRow.getByRole('button', { name: 'Show 1 child workspace' })).toBeVisible()
    await expect(childRow).toBeHidden()

    await parentRow.getByRole('button', { name: 'Show 1 child workspace' }).click()
    await orcaPage.evaluate((childId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Why: this test covers lineage row rendering. Clearing through the
      // store keeps it focused on the render contract instead of nested
      // context-menu hit testing.
      void store.getState().updateWorktreeLineage(childId, { noParent: true })
    }, childId)
    await expect(parentRow.getByRole('button', { name: /child workspace/ })).toHaveCount(0)
    await expect(childRow).toBeVisible()

    await parentRow.click({ button: 'right' })
    await expect(
      orcaPage.getByRole('menuitem', { name: 'Group under Active Workspace' })
    ).toHaveCount(0)
  })

  test('shows parent and child agent rows while the parent workspace is active', async ({
    orcaPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage)
    const parentRow = worktreeOption(orcaPage, parentId)
    const childRow = worktreeOption(orcaPage, childId)

    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')
    await expect(childRow).toBeVisible()

    const parentAgentPrompt = await seedWorkspaceAgentStatus(orcaPage, parentId, 'PARENT')
    const childAgentPrompt = await seedWorkspaceAgentStatus(orcaPage, childId, 'CHILD')

    await expect(parentRow.locator(`span[title="${parentAgentPrompt}"]`)).toBeVisible()
    await expect(childRow.locator(`span[title="${childAgentPrompt}"]`)).toBeVisible()
  })
})
