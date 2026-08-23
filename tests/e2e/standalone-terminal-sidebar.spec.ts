import { FLOATING_TERMINAL_WORKTREE_ID } from '../../src/shared/constants'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

test.describe('Standalone terminal sidebar', () => {
  test.use({ seedTestRepo: false })

  test('opens home terminals in the main workbench and renames them', async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    const initialWorktreeId = await orcaPage.evaluate(
      () => window.__store?.getState().activeWorktreeId ?? null
    )
    expect(initialWorktreeId).toBeNull()

    const section = orcaPage.locator('[data-standalone-terminal-section]')
    await expect(section).toBeVisible()
    await section.locator('[data-standalone-terminal-create]').click()

    await expect
      .poll(
        () =>
          orcaPage.evaluate((worktreeId) => {
            const state = window.__store?.getState()
            const tab = state?.tabsByWorktree[worktreeId]?.at(-1)
            return tab
              ? {
                  activeWorktreeId: state.activeWorktreeId,
                  id: tab.id,
                  startupCwd: tab.startupCwd ?? null
                }
              : null
          }, FLOATING_TERMINAL_WORKTREE_ID),
        { timeout: 10_000 }
      )
      .not.toBeNull()

    const firstState = await orcaPage.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      const tab = state?.tabsByWorktree[worktreeId]?.at(-1)
      return {
        activeWorktreeId: state?.activeWorktreeId ?? null,
        id: tab?.id ?? null,
        startupCwd: tab?.startupCwd ?? null
      }
    }, FLOATING_TERMINAL_WORKTREE_ID)
    const expectedHome = await orcaPage.evaluate(() =>
      window.api.app.getFloatingTerminalCwd({ path: '~' })
    )

    expect(firstState.activeWorktreeId).toBe(FLOATING_TERMINAL_WORKTREE_ID)
    expect(firstState.startupCwd).toBe(expectedHome)
    await expect(
      orcaPage.locator(`[data-tab-id=${JSON.stringify(firstState.id)}][data-active="true"]`)
    ).toBeVisible()
    await expect(
      orcaPage.locator('[data-floating-terminal-panel][aria-hidden="false"]')
    ).toHaveCount(0)

    await section.locator('[data-standalone-terminal-create]').click()
    await expect
      .poll(
        () =>
          orcaPage.evaluate(
            (worktreeId) => window.__store?.getState().tabsByWorktree[worktreeId]?.length ?? 0,
            FLOATING_TERMINAL_WORKTREE_ID
          ),
        { timeout: 10_000 }
      )
      .toBe(2)

    const secondTabId = await orcaPage.evaluate((worktreeId) => {
      const tabs = window.__store?.getState().tabsByWorktree[worktreeId] ?? []
      return tabs.at(-1)?.id ?? null
    }, FLOATING_TERMINAL_WORKTREE_ID)
    await section
      .locator(`[data-standalone-terminal-rename=${JSON.stringify(secondTabId)}]`)
      .click()
    const renameInput = section.locator('[data-standalone-terminal-rename-input]')
    await renameInput.fill('Server logs')
    await renameInput.press('Enter')

    await expect
      .poll(() =>
        orcaPage.evaluate((worktreeId) => {
          const tabs = window.__store?.getState().tabsByWorktree[worktreeId] ?? []
          return tabs.at(-1)?.customTitle ?? null
        }, FLOATING_TERMINAL_WORKTREE_ID)
      )
      .toBe('Server logs')
    await expect(
      orcaPage.locator('[data-tab-title="Server logs"][data-active="true"]')
    ).toBeVisible()

    await orcaPage.evaluate((worktreeId) => {
      const store = window.__store
      const state = store?.getState()
      if (!store || !state) {
        return
      }
      store.setState({
        activeTabType: 'editor',
        activeTabTypeByWorktree: {
          ...state.activeTabTypeByWorktree,
          [worktreeId]: 'editor'
        }
      })
    }, FLOATING_TERMINAL_WORKTREE_ID)
    await section.locator(`[data-standalone-terminal-tab=${JSON.stringify(firstState.id)}]`).click()
    await expect
      .poll(() => orcaPage.evaluate(() => window.__store?.getState().activeTabType ?? null))
      .toBe('terminal')
  })
})
