import { expect, test } from './helpers/orca-app'

test('selected worktrees expose bulk sleep, delete, and detach actions', async ({ orcaPage }) => {
  const worktreeIds = await orcaPage.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('Orca store unavailable')
    }
    const state = store.getState()
    const worktrees = Object.values(state.worktreesByRepo).flat()
    const parent = worktrees.find((worktree) => worktree.isMainWorktree)
    const child = worktrees.find((worktree) => !worktree.isMainWorktree)
    if (!parent || !child) {
      throw new Error('Expected primary and secondary worktrees')
    }

    store.setState((current) => ({
      worktreeLineageById: {
        ...current.worktreeLineageById,
        [child.id]: {
          worktreeId: child.id,
          worktreeInstanceId: child.instanceId,
          parentWorktreeId: parent.id,
          parentWorktreeInstanceId: parent.instanceId,
          origin: 'cli',
          capture: { source: 'explicit-cli-flag', confidence: 'explicit' },
          createdAt: Date.now()
        }
      },
      updateWorktreeLineage: async (worktreeId, args) => {
        if (!args.noParent) {
          return
        }
        const previousCalls = document.body.dataset.bulkDetachCalls
        document.body.dataset.bulkDetachCalls = previousCalls
          ? `${previousCalls},${worktreeId}`
          : worktreeId
        store.setState((latest) => {
          const worktreeLineageById = { ...latest.worktreeLineageById }
          delete worktreeLineageById[worktreeId]
          return { worktreeLineageById, sortEpoch: latest.sortEpoch + 1 }
        })
      },
      sortEpoch: current.sortEpoch + 1
    }))
    state.createBrowserTab(parent.id, 'about:blank', { title: 'bulk-parent', activate: false })
    state.createBrowserTab(child.id, 'about:blank', { title: 'bulk-child', activate: false })
    return { parentId: parent.id, childId: child.id }
  })

  const parentRow = orcaPage.locator(`[data-worktree-id="${worktreeIds.parentId}"]`).first()
  const childRow = orcaPage.locator(`[data-worktree-id="${worktreeIds.childId}"]`).first()
  const parentCard = parentRow.locator(
    ':scope > [data-worktree-context-menu-scope] > [data-worktree-card-surface]'
  )
  const childCard = childRow.locator(
    ':scope > [data-worktree-context-menu-scope] > [data-worktree-card-surface]'
  )
  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'

  await expect(parentRow).toBeVisible()
  await expect(childRow).toBeVisible()
  await parentCard.click({ modifiers: [modifier] })
  await childCard.click({ modifiers: [modifier] })
  await expect(parentRow).toHaveAttribute('aria-selected', 'true')
  await expect(childRow).toHaveAttribute('aria-selected', 'true')

  await childCard.click({ button: 'right' })
  await expect(orcaPage.getByRole('menuitem', { name: 'Sleep 2 Workspaces' })).toBeVisible()
  await expect(orcaPage.getByRole('menuitem', { name: 'Delete 1 Workspace' })).toBeVisible()
  await expect(orcaPage.getByRole('menuitem', { name: 'Remove from Parent' })).toBeVisible()

  await orcaPage.getByRole('menuitem', { name: 'Remove from Parent' }).click()
  await expect(orcaPage.locator('body')).toHaveAttribute(
    'data-bulk-detach-calls',
    worktreeIds.childId
  )
  await expect(parentRow.locator('[data-worktree-lineage-children]')).toHaveCount(0)
})
