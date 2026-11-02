import { chmodSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { removeWorktreeViaStore } from './helpers/dead-terminal'
import { expect, test } from './helpers/orca-app'
import { SIDEBAR_INPUTS_BUILD, expectNoSidebarShadowMismatches } from './helpers/sidebar-shadow'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { getActiveWorktreeId, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test.skip(!SIDEBAR_INPUTS_BUILD, 'main lists creations only in an ORCA_SIDEBAR_INPUTS=main build')

function readCreations(page: Page): Promise<{ pending: string[]; host: string[] }> {
  return page.evaluate(async () => {
    const response = await window.api.runtime.call({ method: 'sidebarInputs.workspaceCreations' })
    const result: unknown = response.ok ? response.result : null
    const creations: unknown =
      result && typeof result === 'object' && 'creations' in result ? result.creations : null
    return {
      pending: Object.keys(window.__store!.getState().pendingWorktreeCreations),
      host: creations && typeof creations === 'object' ? Object.keys(creations) : []
    }
  })
}

test('main lists a window create while it runs and drops it when the workspace lands', async ({
  orcaPage,
  testRepoPath
}) => {
  test.setTimeout(120_000)
  await waitForSessionReady(orcaPage)
  const originalWorktreeId = await waitForActiveWorktree(orcaPage)
  // Holds `git worktree add` in main long enough for two shadow comparisons.
  const hookPath = path.join(testRepoPath, '.git', 'hooks', 'post-checkout')
  writeFileSync(hookPath, '#!/bin/sh\nsleep 8\n')
  chmodSync(hookPath, 0o755)
  const name = `registry-${Date.now()}`
  let createdId: string | null = null

  try {
    await openSidebarWorkspaceComposer(orcaPage)
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await dialog.getByPlaceholder(/Type a name/i).fill(name)
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()

    await expect
      .poll(async () => {
        const { pending, host } = await readCreations(orcaPage)
        return pending.length === 1 && host.includes(pending[0])
      })
      .toBe(true)
    await expectNoSidebarShadowMismatches(orcaPage)

    await expect
      .poll(async () => (await readCreations(orcaPage)).pending.length, { timeout: 30_000 })
      .toBe(0)
    expect((await readCreations(orcaPage)).host).toEqual([])
    createdId = await getActiveWorktreeId(orcaPage)
    expect(createdId).not.toBe(originalWorktreeId)
    await expectNoSidebarShadowMismatches(orcaPage)
  } finally {
    rmSync(hookPath, { force: true })
    if (createdId && createdId !== originalWorktreeId) {
      await removeWorktreeViaStore(orcaPage, createdId)
    }
  }
})
