/**
 * "Open workspace" in the branch picker activates the workspace that holds the branch the same
 * way the sidebar does: a workspace whose tabs were closed on purpose gets its default surface
 * again instead of a blank window.
 */
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { activateWorkspaceByClick } from './helpers/slept-workspace-probe'
import { waitForActivePanePtyId } from './helpers/terminal'
import { openSourceControl } from './helpers/source-control-ai-generation'
import { removeWorktreeViaStore } from './helpers/dead-terminal'

function readWorkspaceSurface(page: Page, worktreeId: string) {
  return page.evaluate((id) => {
    const state = window.__store!.getState()
    return {
      active: state.activeWorktreeId === id,
      renderableTabs: state.reconcileWorktreeTabModel(id).renderableTabCount,
      visibleTerminals: Array.from(document.querySelectorAll('.xterm')).filter(
        (el) => el instanceof HTMLElement && el.offsetParent !== null
      ).length
    }
  }, worktreeId)
}

test('Open workspace in the branch picker shows a workspace whose tabs were closed', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  const first = await waitForActiveWorktree(orcaPage)
  const { target, branch } = await orcaPage.evaluate(async (firstId) => {
    const state = window.__store!.getState()
    const repoId = state.getKnownWorktreeById(firstId)!.repoId
    const created = await state.createWorktree(
      repoId,
      `e2e-open-workspace-${Date.now()}`,
      undefined,
      'skip'
    )
    await state.fetchWorktrees(repoId)
    const branchRef = state.getKnownWorktreeById(created.worktree.id)?.branch ?? ''
    return { target: created.worktree.id, branch: branchRef.replace(/^refs\/heads\//, '') }
  }, first)

  await activateWorkspaceByClick(orcaPage, target)
  await waitForActivePanePtyId(orcaPage, 30_000)
  await orcaPage.evaluate((id) => {
    const state = window.__store!.getState()
    for (const tab of state.unifiedTabsByWorktree[id] ?? []) {
      state.closeUnifiedTab(tab.id)
    }
  }, target)
  await activateWorkspaceByClick(orcaPage, first)
  // Closed on purpose: the automatic first-visit shell no longer seeds it, only an explicit open does.
  await expect
    .poll(() =>
      orcaPage.evaluate((id) => {
        const state = window.__store!.getState()
        return {
          renderableTabs: state.reconcileWorktreeTabModel(id).renderableTabCount,
          emptiedTerminalRow: Object.hasOwn(state.tabsByWorktree, id),
          closeRecorded: Object.values(state.closedTerminalTabTombstonesByTabId).some(
            (record) => record.worktreeId === id
          )
        }
      }, target)
    )
    .toEqual({ renderableTabs: 0, emptiedTerminalRow: true, closeRecorded: true })

  await openSourceControl(orcaPage, first)
  await orcaPage
    .getByRole('button', { name: /^Switch branch:/ })
    .first()
    .click()
  await orcaPage
    .getByRole('option')
    .filter({ hasText: branch })
    .filter({ hasText: 'Open workspace' })
    .click()

  await expect
    .poll(() => readWorkspaceSurface(orcaPage, target), { timeout: 20_000 })
    .toEqual({ active: true, renderableTabs: 1, visibleTerminals: 1 })

  await removeWorktreeViaStore(orcaPage, target)
})
