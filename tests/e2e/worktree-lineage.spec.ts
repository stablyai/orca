import type { Page } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  markWorkspaceTerminalSlept,
  seedLineageScenario,
  seedWorkspaceAgentStatus,
  seedWorkspaceLiveTerminal
} from './worktree-lineage-state'
import { worktreeRow } from './worktree-row-locators'

function worktreeOption(page: Page, worktreeId: string) {
  return worktreeRow(page, worktreeId)
}

async function captureSidebarEvidence(page: Page, name: string): Promise<void> {
  if (process.env.ORCA_CAPTURE_EVIDENCE !== '1') {
    return
  }
  const outputDir = resolve(process.cwd(), 'pr-evidence')
  mkdirSync(outputDir, { recursive: true })
  await page
    .locator('[data-worktree-sidebar]')
    .first()
    .screenshot({
      path: resolve(outputDir, name)
    })
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
      // Why: this test covers lineage row rendering. Clearing through the
      // store keeps it focused on the render contract instead of nested
      // context-menu hit testing.
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

  test('renders legacy-only inline lineage when side-map hydration is absent', async ({
    orcaPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage, { inlineOnly: true })
    const parentRow = worktreeOption(orcaPage, parentId)
    const childRow = worktreeOption(orcaPage, childId)

    await expect(parentRow.getByRole('button', { name: 'Hide 1 child workspace' })).toBeVisible()
    await expect(childRow).toBeVisible()
    await expect
      .poll(async () => {
        const [parentBox, childBox] = await Promise.all([
          parentRow.boundingBox(),
          childRow.boundingBox()
        ])
        return parentBox && childBox ? childBox.y > parentBox.y : false
      })
      .toBe(true)
    await captureSidebarEvidence(orcaPage, 'legacy-inline-lineage-nested.png')
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

  test('updates nested child preview status when the child terminal sleeps', async ({
    orcaPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage)
    const parentRow = worktreeOption(orcaPage, parentId)
    const childRow = worktreeOption(orcaPage, childId)

    await expect(parentRow).toBeVisible()
    await expect(childRow).toBeVisible()

    const childTabId = await seedWorkspaceLiveTerminal(orcaPage, childId)
    await expect(childRow).toContainText('Active')

    await markWorkspaceTerminalSlept(orcaPage, { worktreeId: childId, tabId: childTabId })
    await expect(childRow).toContainText('Inactive')
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

    await expect(
      parentRow.getByRole('treeitem').filter({ hasText: parentAgentPrompt })
    ).toBeVisible()
    await expect(childRow.getByRole('treeitem').filter({ hasText: childAgentPrompt })).toBeVisible()
  })
})
