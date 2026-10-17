import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForActiveWorktree,
  waitForSessionReady
} from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import { worktreeRow } from './worktree-row-locators'

async function createIsolatedWorktree(
  page: Parameters<typeof waitForActiveWorktree>[0]
): Promise<string> {
  const name = `e2e-delete-shortcut-${Date.now()}`
  return page.evaluate(async (worktreeName) => {
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('No active worktree to derive repo from')
    }
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === state.activeWorktreeId)
    if (!worktree) {
      throw new Error('Active worktree was not found')
    }

    const result = await state.createWorktree(worktree.repoId, worktreeName)
    await state.fetchWorktrees(worktree.repoId)
    return result.worktree.id
  }, name)
}

test.describe('Worktree Delete Shortcut', () => {
  let createdWorktreeId: string | null = null

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test.afterEach(async ({ orcaPage }) => {
    if (!createdWorktreeId) {
      return
    }
    const worktreeId = createdWorktreeId
    createdWorktreeId = null
    await orcaPage
      .evaluate(async (id) => {
        const state = window.__store?.getState()
        await state?.removeWorktree(
          { id, executionHostId: state.getKnownWorktreeById(id)?.hostId ?? null },
          true
        )
      }, worktreeId)
      .catch(() => undefined)
  })

  test('deletes the active worktree on a second Mod+Shift+Backspace, ignoring the hovered row', async ({
    orcaPage
  }) => {
    const hoveredId = await getActiveWorktreeId(orcaPage)
    createdWorktreeId = await createIsolatedWorktree(orcaPage)
    const worktreeId = createdWorktreeId
    await switchToWorktree(orcaPage, worktreeId)
    await ensureTerminalVisible(orcaPage)
    const row = worktreeRow(orcaPage, worktreeId)
    await expect(row).toBeVisible()
    await worktreeRow(orcaPage, hoveredId!).hover()

    await pressShortcut(orcaPage, 'Backspace', { shift: true })
    await expect(row.locator('[data-workspace-delete-confirm]')).toBeVisible()
    await expect(
      worktreeRow(orcaPage, hoveredId!).locator('[data-workspace-delete-confirm]')
    ).toHaveCount(0)
    await expect(orcaPage.getByRole('dialog')).toHaveCount(0)

    await pressShortcut(orcaPage, 'Backspace', { shift: true })
    await expect
      .poll(async () => getAllWorktreeIds(orcaPage), {
        timeout: 15_000,
        message: 'active worktree was not removed by the second press'
      })
      .not.toContain(worktreeId)
    expect(await getAllWorktreeIds(orcaPage)).toContain(hoveredId)
    await expect(orcaPage.getByRole('dialog')).toHaveCount(0)
    createdWorktreeId = null
  })

  test('Escape cancels an armed delete', async ({ orcaPage }) => {
    createdWorktreeId = await createIsolatedWorktree(orcaPage)
    const worktreeId = createdWorktreeId
    await switchToWorktree(orcaPage, worktreeId)
    await ensureTerminalVisible(orcaPage)
    const row = worktreeRow(orcaPage, worktreeId)
    await expect(row).toBeVisible()

    await pressShortcut(orcaPage, 'Backspace', { shift: true })
    await expect(row.locator('[data-workspace-delete-confirm]')).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(row.locator('[data-workspace-delete-confirm]')).toHaveCount(0)
    expect(await getAllWorktreeIds(orcaPage)).toContain(worktreeId)
  })
})
