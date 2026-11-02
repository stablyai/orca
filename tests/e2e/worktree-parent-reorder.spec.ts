import { test, expect } from './helpers/orca-app'
import { evaluatePolled } from './helpers/page-evaluate-polled'
import {
  addRepoWithWorkspaces,
  linkWorkspaces,
  writeWorkspaceMeta
} from './helpers/repo-with-workspaces'
import { waitForSessionReady } from './helpers/store'

test.use({ seedTestRepo: false })

for (const newCardStyle of [false, true]) {
  test(`reorders a collapsed parent with 53 children (${newCardStyle ? 'new' : 'legacy'} cards)`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    // First, parent, 53 children, last; the repo's own checkout sorts below them all.
    const repo = await addRepoWithWorkspaces(orcaPage, testInfo, 56)
    const [firstId, parentId, ...rest] = repo.ids
    const childIds = rest.slice(0, 53)
    const lastId = rest[53]!
    const rank = (id: string, name: string, manualOrder: number) => ({
      worktreeId: id,
      updates: { displayName: name, manualOrder, sortOrder: manualOrder }
    })
    await writeWorkspaceMeta(orcaPage, [
      rank(repo.mainId, 'Main workspace', 1),
      rank(firstId!, 'First workspace', 100_000),
      rank(parentId!, 'Parent with 53 children', 90_000),
      ...childIds.map((id, index) => rank(id, `Child ${index}`, 80_000 - index * 100)),
      rank(lastId, 'Last workspace', 10_000)
    ])
    await linkWorkspaces(
      orcaPage,
      childIds.map((childId) => ({ childId, parentId: parentId! }))
    )
    await evaluatePolled(
      orcaPage,
      async ({ newCardStyle, parentId }) => {
        const store = window.__store!
        const state = store.getState()
        const parent = state.allWorktrees().find((worktree) => worktree.id === parentId)!
        const collapsedGroups = [
          `lineage:${parent.hostId ? `${parent.hostId}|${parent.id}` : parent.id}`
        ]
        await window.api.ui.set({ groupBy: 'none', collapsedGroups })
        await state.updateSettings({ experimentalNewWorktreeCardStyle: newCardStyle })
        store.setState({
          groupBy: 'none',
          sortBy: 'manual',
          sidebarOpen: true,
          showActiveOnly: false,
          showSleepingWorkspaces: true,
          hideDefaultBranchWorkspace: false,
          filterRepoIds: [],
          collapsedGroups: new Set(collapsedGroups)
        })
      },
      { newCardStyle, parentId: parentId! }
    )
    const ids = { first: firstId!, parent: parentId!, last: lastId }
    const sidebar = orcaPage.locator('[data-worktree-sidebar]')
    const parent = sidebar.locator(`[data-worktree-id=${JSON.stringify(ids.parent)}]`)
    const last = sidebar.locator(`[data-worktree-id=${JSON.stringify(ids.last)}]`)
    await expect(parent.getByRole('button', { name: 'Show 53 child workspaces' })).toBeVisible()
    await sidebar.screenshot({ path: testInfo.outputPath('before.png') })
    const source = await parent.boundingBox()
    const target = await last.boundingBox()
    if (!source || !target) {
      throw new Error('Missing card bounds')
    }
    await orcaPage.mouse.move(source.x + source.width / 2, source.y + 12)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(target.x + 2, target.y + target.height - 1, { steps: 12 })
    await expect(orcaPage.locator('[data-worktree-sidebar-drag-preview]')).toHaveCount(1)
    await orcaPage.mouse.up()
    try {
      await expect
        .poll(async () => {
          const [parentBox, lastBox] = await Promise.all([parent.boundingBox(), last.boundingBox()])
          return Boolean(parentBox && lastBox && parentBox.y > lastBox.y)
        })
        .toBe(true)
    } finally {
      await sidebar.screenshot({ path: testInfo.outputPath('after.png') })
    }
    const first = sidebar.locator(`[data-worktree-id=${JSON.stringify(ids.first)}]`)
    const movedSource = await parent.boundingBox()
    const upwardTarget = await first.boundingBox()
    if (!movedSource || !upwardTarget) {
      throw new Error('Missing reordered card bounds')
    }
    await orcaPage.mouse.move(movedSource.x + movedSource.width / 2, movedSource.y + 12)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(upwardTarget.x + 2, upwardTarget.y + 1, { steps: 12 })
    await orcaPage.mouse.up()
    await expect
      .poll(async () => {
        const [parentBox, firstBox] = await Promise.all([parent.boundingBox(), first.boundingBox()])
        return Boolean(parentBox && firstBox && parentBox.y < firstBox.y)
      })
      .toBe(true)
    // Wait for the drag's click suppression before exercising the children toggle.
    await orcaPage.waitForTimeout(550)
    await parent.getByRole('button', { name: 'Show 53 child workspaces' }).click()
    await expect(parent.getByRole('button', { name: 'Hide 53 child workspaces' })).toBeVisible()
    await expect(parent.locator('[role="option"]')).toHaveCount(53)
    await expect(parent.locator('[role="option"]').first()).toContainText('Child 0')
  })
}
