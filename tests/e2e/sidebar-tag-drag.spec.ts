import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getAllWorktreeIds, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { worktreeRow } from './worktree-row-locators'

async function dragRowOnto(page: Page, worktreeId: string, target: { x: number; y: number }) {
  const box = await worktreeRow(page, worktreeId).boundingBox()
  if (!box) {
    throw new Error(`row ${worktreeId} is not rendered`)
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  // Why several steps: the sidebar arms a drag only after the pointer travels past a threshold.
  await page.mouse.move(target.x, target.y, { steps: 12 })
  await page.mouse.up()
}

test('dragging a workspace onto a tag section adds that tag', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  const [taggedId, untaggedId] = await getAllWorktreeIds(orcaPage)
  expect(untaggedId).toBeDefined()

  // Store is fine for setup; the assertion below reads the rendered card.
  await orcaPage.evaluate(
    async ({ taggedId }) => {
      const state = window.__store!.getState()
      await state.updateWorktreeMeta(taggedId, { tags: ['billing team'] })
      state.setGroupBy('tag')
    },
    { taggedId }
  )

  const header = orcaPage
    .locator('[data-worktree-sidebar]')
    .locator('[data-workspace-tag-drop-target="tag:billing team"]')
    .first()
  await expect(header).toBeVisible()
  const headerBox = await header.boundingBox()
  await dragRowOnto(orcaPage, untaggedId, {
    x: headerBox!.x + headerBox!.width / 2,
    y: headerBox!.y + headerBox!.height / 2
  })

  const chips = orcaPage
    .locator('[data-worktree-sidebar]')
    .locator(`[data-worktree-id="${untaggedId}"]`)
    .first()
    .getByLabel('Tags', { exact: true })
  await expect(chips).toContainText('billing team')
})
