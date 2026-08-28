import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

type PopulatedParentScenario = {
  parentId: string
  originalChildId: string
  newChildId: string
}

async function seedPopulatedParentScenario(page: Page): Promise<PopulatedParentScenario> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const [parent, originalChild] = worktrees
    if (!parent?.instanceId || !originalChild?.instanceId) {
      throw new Error('Populated parent E2E needs two instance-stamped worktrees')
    }
    const newChildId = `${parent.repoId}::populated-parent-new-child`
    const newChild = {
      ...originalChild,
      id: newChildId,
      instanceId: 'populated-parent-new-child-instance',
      path: `${originalChild.path}-populated-parent-new-child`,
      branch: 'populated-parent-new-child',
      displayName: 'E2E new lineage child',
      isMainWorktree: false,
      manualOrder: 1,
      sortOrder: 1
    }
    const originalLineage = {
      worktreeId: originalChild.id,
      worktreeInstanceId: originalChild.instanceId,
      parentWorktreeId: parent.id,
      parentWorktreeInstanceId: parent.instanceId,
      origin: 'manual' as const,
      capture: { source: 'manual-action' as const, confidence: 'explicit' as const },
      createdAt: Date.now()
    }
    store.setState({
      groupBy: 'none',
      sortBy: 'manual',
      showActiveOnly: false,
      showSleepingWorkspaces: true,
      hideDefaultBranchWorkspace: false,
      filterRepoIds: [],
      sidebarOpen: true,
      settings: state.settings
        ? { ...state.settings, experimentalNewWorktreeCardStyle: false }
        : state.settings,
      worktreeLineageById: { [originalChild.id]: originalLineage },
      worktreesByRepo: {
        ...state.worktreesByRepo,
        [parent.repoId]: [
          { ...parent, displayName: 'E2E populated parent', manualOrder: 3, sortOrder: 3 },
          {
            ...originalChild,
            displayName: 'E2E original lineage child',
            manualOrder: 2,
            sortOrder: 2
          },
          newChild
        ]
      },
      assignWorktreeParent: async (worktreeId, { parentWorktreeId }) => {
        const current = store.getState()
        const child = Object.values(current.worktreesByRepo)
          .flat()
          .find((worktree) => worktree.id === worktreeId)
        const lineageParent = Object.values(current.worktreesByRepo)
          .flat()
          .find((worktree) => worktree.id === parentWorktreeId)
        if (!child?.instanceId || !lineageParent?.instanceId) {
          throw new Error('Assigned worktree lineage is missing instance ids')
        }
        store.setState((latest) => ({
          worktreeLineageById: {
            ...latest.worktreeLineageById,
            [worktreeId]: {
              worktreeId,
              worktreeInstanceId: child.instanceId!,
              parentWorktreeId,
              parentWorktreeInstanceId: lineageParent.instanceId!,
              origin: 'manual',
              capture: { source: 'manual-action', confidence: 'explicit' },
              createdAt: Date.now()
            }
          }
        }))
      }
    })
    store.getState().setActiveWorktree(parent.id)
    return { parentId: parent.id, originalChildId: originalChild.id, newChildId }
  })
}

test('drops a separate worktree beside every existing child of a populated parent', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const { parentId, originalChildId, newChildId } = await seedPopulatedParentScenario(orcaPage)
  const parent = worktreeRow(orcaPage, parentId)
  const originalChild = worktreeRow(orcaPage, originalChildId)
  const newChild = worktreeRow(orcaPage, newChildId)
  await expect(parent).toBeVisible()
  await expect(originalChild).toBeVisible()
  await expect(newChild).toBeVisible()

  const [sourceBox, parentDropPoint] = await Promise.all([
    newChild.boundingBox(),
    parent.evaluate((parentElement, childId) => {
      const content = parentElement.querySelector<HTMLElement>('[data-worktree-card-hover-trigger]')
      const child = [...parentElement.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
        (element) => element.dataset.worktreeId === childId
      )
      if (!content || !child) {
        return null
      }
      const contentRect = content.getBoundingClientRect()
      const childRect = child.getBoundingClientRect()
      return {
        x: contentRect.left + contentRect.width / 2,
        y: contentRect.top + (childRect.top - contentRect.top) / 2
      }
    }, originalChildId)
  ])
  if (!sourceBox || !parentDropPoint) {
    throw new Error('Expected visible source and populated parent rows')
  }
  await orcaPage.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await orcaPage.mouse.down()
  await orcaPage.mouse.move(parentDropPoint.x, parentDropPoint.y, { steps: 8 })
  await orcaPage.mouse.up()

  await expect(parent.getByRole('button', { name: 'Hide 2 child workspaces' })).toBeVisible()
  const directChildren = parent.locator('[data-worktree-lineage-children] > [data-worktree-id]')
  await expect(directChildren).toHaveCount(2)
  await expect(directChildren.filter({ hasText: 'E2E original lineage child' })).toBeVisible()
  await expect(directChildren.filter({ hasText: 'E2E new lineage child' })).toBeVisible()
})
