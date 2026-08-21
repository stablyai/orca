import type { Locator, Page } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './helpers/mcode-app'
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

async function captureEvidence(page: Page, name: string, locator?: Locator): Promise<void> {
  if (process.env.MCODE_CAPTURE_EVIDENCE !== '1') {
    return
  }
  const outputDir = resolve(process.cwd(), 'pr-evidence')
  mkdirSync(outputDir, { recursive: true })
  const path = resolve(outputDir, name)
  if (locator) {
    await locator.screenshot({ path })
    return
  }
  await page.screenshot({ path })
}

async function captureSidebarEvidence(page: Page, name: string): Promise<void> {
  await captureEvidence(page, name, page.locator('[data-worktree-sidebar]').first())
}

test.describe('Worktree Lineage', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
    await waitForActiveWorktree(mcodePage)
  })

  test('renders existing child lineage in the sidebar', async ({ mcodePage }) => {
    const { parentId, childId } = await seedLineageScenario(mcodePage)
    const parentRow = worktreeOption(mcodePage, parentId)
    const childRow = worktreeOption(mcodePage, childId)

    await expect(parentRow).toBeVisible()
    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')

    await expect(childRow).toBeVisible()
    const childToggle = parentRow.getByRole('button', { name: 'Hide 1 child workspace' })
    await expect(childToggle).toBeVisible({ timeout: 10_000 })
    await expect(childRow).toBeVisible()

    const positions = await mcodePage.evaluate(
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
    await mcodePage.evaluate(async (childId) => {
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
          mcodePage.evaluate((childId) => {
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
    mcodePage
  }) => {
    const { parentId, childId } = await seedLineageScenario(mcodePage, { inlineOnly: true })
    const parentRow = worktreeOption(mcodePage, parentId)
    const childRow = worktreeOption(mcodePage, childId)

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
    await captureSidebarEvidence(mcodePage, 'legacy-inline-lineage-nested.png')
  })

  test('injects filtered parents structurally without showing a parent badge', async ({
    mcodePage
  }) => {
    const { parentId, childId } = await seedLineageScenario(mcodePage)

    await mcodePage.evaluate(
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

    const parentRow = worktreeOption(mcodePage, parentId)
    const childRow = worktreeOption(mcodePage, childId)

    await expect(parentRow).toBeVisible()
    await expect(childRow).toBeVisible()
    await expect(childRow).not.toContainText(/\bfrom\b/)

    const positions = await mcodePage.evaluate(
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
    mcodePage
  }) => {
    const { parentId, childId } = await seedLineageScenario(mcodePage)
    const parentRow = worktreeOption(mcodePage, parentId)
    const childRow = worktreeOption(mcodePage, childId)

    await expect(parentRow).toBeVisible()
    await expect(childRow).toBeVisible()

    const childTabId = await seedWorkspaceLiveTerminal(mcodePage, childId)
    await expect(childRow).toContainText('Active')

    await markWorkspaceTerminalSlept(mcodePage, { worktreeId: childId, tabId: childTabId })
    await expect(childRow).toContainText('Inactive')
  })

  test('sleeps a workspace and every descendant from the parent context menu', async ({
    mcodePage
  }) => {
    const { parentId, childId } = await seedLineageScenario(mcodePage)
    await mcodePage.evaluate((parentId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState((current) => ({
        worktreesByRepo: Object.fromEntries(
          Object.entries(current.worktreesByRepo).map(([repoId, worktrees]) => [
            repoId,
            worktrees.map((worktree) =>
              worktree.id === parentId ? { ...worktree, isMainWorktree: false } : worktree
            )
          ])
        )
      }))
    }, parentId)
    const parentTabId = await seedWorkspaceLiveTerminal(mcodePage, parentId)
    const childTabId = await seedWorkspaceLiveTerminal(mcodePage, childId)

    await mcodePage.evaluate(() => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState({
        shutdownWorktreeBrowsers: async (worktreeId: string) => {
          store.setState((current) => ({
            browserTabsByWorktree: { ...current.browserTabsByWorktree, [worktreeId]: [] }
          }))
        },
        shutdownWorktreeTerminals: async (worktreeId: string) => {
          const tabIds = (store.getState().tabsByWorktree[worktreeId] ?? []).map((tab) => tab.id)
          store.setState((current) => ({
            ptyIdsByTabId: {
              ...current.ptyIdsByTabId,
              ...Object.fromEntries(tabIds.map((tabId) => [tabId, []]))
            }
          }))
        }
      })
      window.api.ephemeralVm.suspendWorkspace = async () => null
    })

    await worktreeOption(mcodePage, parentId).click({ button: 'right' })
    const sleepSubtree = mcodePage.getByRole('menuitem', {
      name: 'Sleep with Descendants (1)'
    })
    await expect(sleepSubtree).toBeVisible()
    await expect(sleepSubtree).toBeEnabled()
    await expect(mcodePage.getByRole('menuitem', { name: 'Delete with Descendants…' })).toBeVisible()
    await captureEvidence(mcodePage, 'workspace-descendant-actions.png')
    await sleepSubtree.click()

    await expect
      .poll(() =>
        mcodePage.evaluate(
          ({ parentTabId, childTabId }) => {
            const state = window.__store?.getState()
            return {
              parentPtys: state?.ptyIdsByTabId[parentTabId],
              childPtys: state?.ptyIdsByTabId[childTabId]
            }
          },
          { parentTabId, childTabId }
        )
      )
      .toEqual({ parentPtys: [], childPtys: [] })
  })

  test('shows parent and child agent rows while the parent workspace is active', async ({
    mcodePage
  }) => {
    const { parentId, childId } = await seedLineageScenario(mcodePage)
    const parentRow = worktreeOption(mcodePage, parentId)
    const childRow = worktreeOption(mcodePage, childId)

    await parentRow.click()
    await expect(parentRow).toHaveAttribute('aria-current', 'page')
    await expect(childRow).toBeVisible()

    const parentAgentPrompt = await seedWorkspaceAgentStatus(mcodePage, parentId, 'PARENT')
    const childAgentPrompt = await seedWorkspaceAgentStatus(mcodePage, childId, 'CHILD')

    await expect(
      parentRow.getByRole('treeitem').filter({ hasText: parentAgentPrompt })
    ).toBeVisible()
    await expect(childRow.getByRole('treeitem').filter({ hasText: childAgentPrompt })).toBeVisible()
  })
})
