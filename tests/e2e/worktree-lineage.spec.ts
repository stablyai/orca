import type { Locator, Page } from '@stablyai/playwright-test'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  markWorkspaceTerminalSlept,
  seedLongSidebarDragScenario,
  seedLineageScenario,
  seedWorkspaceAgentStatus,
  seedWorkspaceLiveTerminal
} from './worktree-lineage-state'
import { worktreeRow, worktreeRowSurface } from './worktree-row-locators'

function worktreeOption(page: Page, worktreeId: string) {
  return worktreeRow(page, worktreeId)
}

async function captureEvidence(page: Page, name: string, locator?: Locator): Promise<void> {
  if (process.env.ORCA_CAPTURE_EVIDENCE !== '1') {
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

async function pauseRecordedProof(page: Page, durationMs = 600): Promise<void> {
  if (process.env.ORCA_E2E_RECORD_VIDEO === '1') {
    await page.waitForTimeout(durationMs)
  }
}

test.describe('Worktree Lineage', () => {
  test.describe.configure({ mode: 'serial' })

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
  })

  test('autoscrolls through nested agent rows and nests a workspace from its title', async ({
    orcaPage
  }) => {
    const scenario = await seedLongSidebarDragScenario(orcaPage)
    const scroller = orcaPage.locator('[data-worktree-sidebar]')
    const sourceRow = worktreeRow(orcaPage, scenario.sourceId)
    const targetRow = worktreeRow(orcaPage, scenario.targetId)
    const sourceTitle = sourceRow.locator('[data-worktree-title-inline-rename]').first()
    const targetEndAgent = targetRow.getByText('Target agent 15')
    const targetDropAgent = targetRow.getByText('Target agent 13')

    await expect(sourceRow).toBeVisible()
    await expect(sourceRow.getByText('Source agent 15')).toBeVisible()
    await expect
      .poll(() =>
        scroller.evaluate((element) => Math.max(0, element.scrollHeight - element.clientHeight))
      )
      .toBeGreaterThan(80)
    await scroller.evaluate((element) => {
      element.scrollTop = 0
    })
    await pauseRecordedProof(orcaPage)

    const [sourceBox, sourceTitleBox, scrollerBox] = await Promise.all([
      sourceRow.boundingBox(),
      sourceTitle.boundingBox(),
      scroller.boundingBox()
    ])
    if (!sourceBox || !sourceTitleBox || !scrollerBox) {
      throw new Error('Expected long sidebar drag geometry')
    }
    const dragX = sourceTitleBox.x + sourceTitleBox.width / 2
    await orcaPage.mouse.move(dragX, sourceTitleBox.y + sourceTitleBox.height / 2)
    await orcaPage.mouse.down()
    try {
      await orcaPage.mouse.move(dragX, sourceTitleBox.y + sourceTitleBox.height + 8, { steps: 4 })
      await expect(orcaPage.locator('html')).toHaveAttribute(
        'data-worktree-sidebar-pointer-dragging',
        ''
      )
      const preview = orcaPage.locator('[data-worktree-sidebar-drag-preview="true"]')
      await expect(preview).toBeVisible()
      const previewBox = await preview.boundingBox()
      expect(previewBox?.height ?? Number.POSITIVE_INFINITY).toBeLessThan(sourceBox.height)

      const initialScrollTop = await scroller.evaluate((element) => element.scrollTop)
      await orcaPage.mouse.move(dragX, scrollerBox.y + scrollerBox.height - 3, { steps: 12 })
      await expect
        .poll(() => scroller.evaluate((element) => element.scrollTop), { timeout: 15_000 })
        .toBeGreaterThan(initialScrollTop + 50)
      await expect
        .poll(
          async () => {
            const [agentBox, sidebarBox] = await Promise.all([
              targetEndAgent.boundingBox(),
              scroller.boundingBox()
            ])
            return Boolean(
              agentBox &&
              sidebarBox &&
              agentBox.y >= sidebarBox.y &&
              agentBox.y + agentBox.height <= sidebarBox.y + sidebarBox.height
            )
          },
          { timeout: 15_000, message: 'pointer autoscroll did not reveal the target agent' }
        )
        .toBe(true)
      const targetDropAgentBox = await targetDropAgent.boundingBox()
      if (!targetDropAgentBox) {
        throw new Error('Expected the autoscrolled lineage target agent')
      }
      // Why: the final row borders the reorder gutter; an interior row proves the owned agent surface.
      await orcaPage.mouse.move(
        targetDropAgentBox.x + targetDropAgentBox.width / 2,
        targetDropAgentBox.y + targetDropAgentBox.height / 2
      )
      await expect(worktreeRowSurface(orcaPage, scenario.targetId)).toHaveAttribute(
        'data-worktree-lineage-drop-target',
        'true'
      )
      const targetAgentList = worktreeRowSurface(orcaPage, scenario.targetId)
        .locator('[data-worktree-card-agent-list]')
        .first()
      const sourceAgentList = worktreeRowSurface(orcaPage, scenario.sourceId)
        .locator('[data-worktree-card-agent-list]')
        .first()
      await expect(targetAgentList).toHaveAttribute(
        'data-worktree-card-agent-list-drop-target',
        'true'
      )
      await expect
        .poll(async () => {
          const [targetStyle, sourceStyle] = await Promise.all(
            [targetAgentList, sourceAgentList].map((agentList) =>
              agentList.evaluate((element) => {
                const style = getComputedStyle(element)
                return { backgroundColor: style.backgroundColor, boxShadow: style.boxShadow }
              })
            )
          )
          return (
            targetStyle.backgroundColor !== sourceStyle.backgroundColor &&
            targetStyle.boxShadow !== sourceStyle.boxShadow
          )
        })
        .toBe(true)
      await pauseRecordedProof(orcaPage)
      await orcaPage.mouse.up()

      await expect(
        targetRow.getByRole('button', {
          name: /Hide \d+ child workspaces?/
        })
      ).toBeVisible({ timeout: 15_000 })
      await expect
        .poll(() =>
          targetRow.evaluate(
            (element, sourceId) =>
              Boolean(
                [...element.querySelectorAll<HTMLElement>('[data-worktree-id]')].find(
                  (candidate) => candidate.dataset.worktreeId === sourceId
                )
              ),
            scenario.sourceId
          )
        )
        .toBe(true)
      await expect(preview).toHaveCount(0)
      await expect(orcaPage.locator('html')).not.toHaveAttribute(
        'data-worktree-sidebar-pointer-dragging'
      )
      await pauseRecordedProof(orcaPage, 900)
    } finally {
      await orcaPage.mouse.up().catch(() => {})
      await orcaPage.evaluate(async (sourceId) => {
        await window.__store?.getState().updateWorktreeLineage(sourceId, { noParent: true })
      }, scenario.sourceId)
    }
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

  test('sleeps a workspace and every descendant from the parent context menu', async ({
    orcaPage
  }) => {
    const { parentId, childId } = await seedLineageScenario(orcaPage)
    await orcaPage.evaluate((parentId) => {
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
    const parentTabId = await seedWorkspaceLiveTerminal(orcaPage, parentId)
    const childTabId = await seedWorkspaceLiveTerminal(orcaPage, childId)

    await orcaPage.evaluate(() => {
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

    await worktreeOption(orcaPage, parentId).click({ button: 'right' })
    const sleepSubtree = orcaPage.getByRole('menuitem', {
      name: 'Sleep with Descendants (1)'
    })
    await expect(sleepSubtree).toBeVisible()
    await expect(sleepSubtree).toBeEnabled()
    await expect(orcaPage.getByRole('menuitem', { name: 'Delete with Descendants…' })).toBeVisible()
    await captureEvidence(orcaPage, 'workspace-descendant-actions.png')
    await sleepSubtree.click()

    await expect
      .poll(() =>
        orcaPage.evaluate(
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
