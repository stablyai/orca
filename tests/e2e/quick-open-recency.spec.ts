/**
 * E2E: Quick Open (Cmd+P) seeds its empty-query order with recent files.
 *
 * Drives the REAL tab MRU (via `activateTab`, the same store path a Ctrl+Tab
 * switch takes) so the assertion exercises the true most-recently-used ordering
 * rather than the newest-open-first fallback. The activation order is chosen so
 * MRU diverges from open order: README is visited after package.json, so a
 * fallback (reversed open order) would list package.json first — only genuine
 * MRU puts README first. Captures a screenshot for the PR demo.
 */

import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  ensureTerminalVisible
} from './helpers/store'

test.describe('Quick Open recency', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test('empty-query Quick Open leads with true MRU order, then recently closed', async ({
    orcaPage
  }, testInfo) => {
    const worktreeId = (await getActiveWorktreeId(orcaPage))!

    // Why: the e2e runner and the app share a host, so Node's path.join yields
    // the separator the app itself would use — never hardcode '/'.
    const base = await orcaPage.evaluate(
      (wtId) =>
        Object.values(window.__store!.getState().worktreesByRepo)
          .flat()
          .find((w) => w.id === wtId)!.path,
      worktreeId
    )
    const filePathByRel = {
      'README.md': join(base, 'README.md'),
      'package.json': join(base, 'package.json'),
      'CLAUDE.md': join(base, 'CLAUDE.md'),
      'tsconfig.json': join(base, 'tsconfig.json')
    }

    // Phase 1: open several editors and close one. tsconfig.json is opened last
    // and stays the active file (excluded from the recents list).
    await orcaPage.evaluate(
      ({ wtId, files }) => {
        const state = window.__store!.getState()
        const open = (rel: keyof typeof files, language: string): void =>
          state.openFile({
            filePath: files[rel],
            relativePath: rel,
            worktreeId: wtId,
            language,
            mode: 'edit'
          })
        open('README.md', 'markdown')
        open('package.json', 'json')
        open('CLAUDE.md', 'markdown')
        state.closeFile(files['CLAUDE.md'])
        open('tsconfig.json', 'json')
      },
      { wtId: worktreeId, files: filePathByRel }
    )

    // Phase 2: the editor tabs are materialized reactively — wait until all three
    // open editors have a unified tab before driving the MRU.
    await expect
      .poll(
        () =>
          orcaPage.evaluate((wtId) => {
            const tabs = window.__store!.getState().unifiedTabsByWorktree[wtId] ?? []
            return tabs.filter((t) => t.contentType === 'editor').length
          }, worktreeId),
        { timeout: 5_000 }
      )
      .toBeGreaterThanOrEqual(3)

    // Phase 3: replay real activations so recentTabIds reflects MRU. Activating
    // package.json BEFORE README makes README the more-recently-used of the two,
    // the opposite of open order. Re-activate tsconfig last to restore it active.
    await orcaPage.evaluate((wtId) => {
      const state = window.__store!.getState()
      const fileIdByPath = new Map(
        state.openFiles.filter((f) => f.worktreeId === wtId).map((f) => [f.relativePath, f.id])
      )
      const tabIdByEntityId = new Map(
        (state.unifiedTabsByWorktree[wtId] ?? [])
          .filter((t) => t.contentType === 'editor')
          .map((t) => [t.entityId, t.id])
      )
      const activate = (rel: string): void => {
        const tabId = tabIdByEntityId.get(fileIdByPath.get(rel)!)
        if (tabId) {
          state.activateTab(tabId)
        }
      }
      activate('package.json')
      activate('README.md')
      activate('tsconfig.json')
      state.openModal('quick-open')
    }, worktreeId)

    const dialog = orcaPage.getByRole('dialog')
    await expect(dialog).toBeVisible({ timeout: 5_000 })

    // README leads package.json (proves MRU, not open-order fallback); the
    // recently-closed CLAUDE.md follows the still-open files. Active tsconfig.json
    // is excluded.
    const items = dialog.locator('[cmdk-item]')
    await expect(items.nth(0)).toContainText('README.md')
    await expect(items.nth(1)).toContainText('package.json')
    await expect(items.nth(2)).toContainText('CLAUDE.md')

    await testInfo.attach('quick-open-recency', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
  })
})
