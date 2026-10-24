import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.use({ launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' } })

for (const newCardStyle of [false, true]) {
  test(`workspace follows its session title and preserves explicit names (new style: ${newCardStyle})`, async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const worktreeId = await waitForActiveWorktree(orcaPage)
    const originalName = await orcaPage.evaluate(
      ({ worktreeId, newCardStyle }) => {
        const state = window.__store!.getState()
        state.setSidebarOpen(true)
        state.setShowSleepingWorkspaces(true)
        window.__store!.setState({
          keybindings: { ...state.keybindings, 'workspace.rename': ['Mod+Alt+R'] },
          settings: {
            ...state.settings,
            tabAutoGenerateTitle: true,
            experimentalNewWorktreeCardStyle: newCardStyle
          }
        })
        return Object.values(state.worktreesByRepo)
          .flat()
          .find((worktree) => worktree.id === worktreeId)!.displayName
      },
      { worktreeId, newCardStyle }
    )
    const row = orcaPage.locator('[data-worktree-sidebar] [role="option"]').filter({
      has: orcaPage.locator('[data-worktree-title-inline-rename]', { hasText: originalName })
    })
    const title = orcaPage.locator(
      '[data-worktree-sidebar] [role="option"][aria-current="page"] [data-worktree-title-inline-rename]'
    )
    await expect(row).toBeVisible()
    await expect(title).toHaveText(originalName)
    await row.screenshot({ path: testInfo.outputPath('before.png') })

    await orcaPage.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      const tab = state.unifiedTabsByWorktree[worktreeId].find(
        (tab) => tab.contentType === 'terminal'
      )!
      window.__store!.setState({
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: state.unifiedTabsByWorktree[worktreeId].map((candidate) =>
            candidate.id === tab.id
              ? { ...candidate, generatedLabel: 'Fix workspace navigation' }
              : candidate
          )
        }
      })
    }, worktreeId)
    await expect(title).toHaveText('Fix workspace navigation')
    await orcaPage
      .locator('[data-worktree-sidebar] [role="option"][aria-current="page"]')
      .screenshot({ path: testInfo.outputPath('after.png') })

    if (newCardStyle) {
      // Exercise the persisted rename path independently of the experimental card's editor lifecycle.
      await orcaPage.evaluate(async (worktreeId) => {
        const result = await window
          .__store!.getState()
          .updateWorktreeMeta(worktreeId, { displayName: 'My daily workspace' })
        if (!result.ok) {
          throw new Error(result.error)
        }
      }, worktreeId)
    } else {
      await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+Alt+r' : 'Control+Alt+r')
      const input = orcaPage.locator('[data-worktree-title-rename-input]')
      await input.fill('My daily workspace')
      await input.press('Enter')
    }
    await expect(title).toHaveText('My daily workspace')
    await orcaPage.evaluate((worktreeId) => {
      const state = window.__store!.getState()
      window.__store!.setState({
        unifiedTabsByWorktree: {
          ...state.unifiedTabsByWorktree,
          [worktreeId]: state.unifiedTabsByWorktree[worktreeId].map((tab) => ({
            ...tab,
            generatedLabel: 'Another task'
          }))
        }
      })
    }, worktreeId)
    await expect(title).toHaveText('My daily workspace')
  })
}
