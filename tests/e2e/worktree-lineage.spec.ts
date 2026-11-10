import type { Page } from '@stablyai/playwright-test'
import 'node:fs'
import 'node:path'
import { test, expect } from './helpers/orca-app'
import './helpers/repo-with-workspaces'
import './helpers/sidebar-inputs-build'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { seedLineageScenario } from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

function worktreeOption(page: Page, worktreeId: string) {
  return worktreeRow(page, worktreeId)
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

    await expect(parentRow).toBeVisible()
    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')

    await expect(childRow).toBeVisible()
    const childToggle = parentRow.getByRole('button', { name: 'Hide 1 child workspace' })
    await expect(childToggle).toBeVisible({ timeout: 10_000 })
    await expect(childRow).toBeVisible()

    const positions = await orcaPage.evaluate(
      ({ parentId, childId }) => {
        const rowFor = (worktreeId: string) =>
          [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
            (element) => element.dataset.worktreeId === worktreeId
          )
        const parent = rowFor(parentId)
        const child = rowFor(childId)
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
    await orcaPage.evaluate(async (childId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      // Clear via store to isolate lineage rendering from nested context-menu hit testing.
      await store.getState().updateWorktreeLineage(childId, { noParent: true })
    }, childId)
    await expect
      .poll(
        () =>
          orcaPage.evaluate((childId) => {
            const store = window.__store
            return Boolean(store?.getState().worktreeLineageById[childId])
          }, childId),
        {
          timeout: 10_000,
          message: 'Child lineage entry did not clear from the store'
        }
      )
      .toBe(false)
    await expect(childRow).toBeVisible()
  })

  test('marks the collapsed child chip while a hidden child is unread', async ({
    orcaPage
  }, testInfo) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage)
    const parentRow = worktreeOption(orcaPage, parentId)
    const childRow = worktreeOption(orcaPage, childId)
    const hiddenUnreadDot = parentRow.locator('[data-lineage-hidden-unread]')
    const setChildUnread = (isUnread: boolean) =>
      orcaPage.evaluate(
        ({ childId, isUnread }) => {
          const state = window.__store?.getState()
          if (!state) {
            throw new Error('window.__store is not available')
          }
          const child = Object.values(state.worktreesByRepo)
            .flat()
            .find((worktree) => worktree.id === childId)
          state.setWorkspaceUnreadByUser(childId, isUnread, child?.hostId ?? 'local')
        },
        { childId, isUnread }
      )

    await parentRow.click()
    await parentRow.getByRole('button', { name: 'Hide 1 child workspace' }).click()
    await expect(childRow).toBeHidden()
    const showToggle = parentRow.getByRole('button', { name: 'Show 1 child workspace' })
    await expect(showToggle).toBeVisible()
    await expect(hiddenUnreadDot).toHaveCount(0)

    try {
      await setChildUnread(true)
      await expect(hiddenUnreadDot).toBeVisible({ timeout: 10_000 })
      await expect(showToggle).toHaveAccessibleDescription(/1 unread/)
      await parentRow.screenshot({ path: testInfo.outputPath('collapsed-chip-unread.png') })

      // Expanded children show their own unread state, so the chip drops its marker.
      await showToggle.click()
      await expect(childRow).toBeVisible()
      await expect(hiddenUnreadDot).toHaveCount(0)
    } finally {
      await setChildUnread(false)
    }
  })

  test('injects filtered parents structurally without showing a parent badge', async ({
    orcaPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage)

    await orcaPage.evaluate(
      ({ parentId, childId }) => {
        const store = window.__store
        if (!store) {
          throw new Error('window.__store is not available')
        }
        store.setState((current) => ({
          worktreesByRepo: Object.fromEntries(
            Object.entries(current.worktreesByRepo).map(([repoId, repoWorktrees]) => [
              repoId,
              repoWorktrees.map((worktree) =>
                worktree.id === parentId
                  ? {
                      ...worktree,
                      branch: worktree.branch || 'refs/heads/main',
                      isMainWorktree: true
                    }
                  : worktree
              )
            ])
          )
        }))
        const state = store.getState()
        state.setHideDefaultBranchWorkspace(true)
        state.setShowActiveOnly(true)
        state.setActiveWorktree(childId)
      },
      { parentId, childId }
    )

    const parentRow = worktreeOption(orcaPage, parentId)
    const childRow = worktreeOption(orcaPage, childId)

    await expect(parentRow).toBeVisible()
    await expect(childRow).toBeVisible()
    await expect(childRow).not.toContainText(/\bfrom\b/)

    const positions = await orcaPage.evaluate(
      ({ parentId, childId }) => {
        const rowFor = (worktreeId: string) =>
          [...document.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
            (element) => element.dataset.worktreeId === worktreeId
          )
        const parent = rowFor(parentId)
        const child = rowFor(childId)
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
  })
})
