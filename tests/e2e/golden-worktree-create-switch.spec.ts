import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/mcode-app'
import { getActiveWorktreeId, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { createTerminalTabFromMenu } from './helpers/terminal-tab-menu'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { splitMarkerEchoCommand } from './terminal-marker-echo-command'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

async function createWorkspace(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'New workspace', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
  await expect(dialog).toBeVisible()
  await dialog.getByPlaceholder(/Type a name/i).fill(name)
  await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
  await expect(dialog).toBeHidden({ timeout: 20_000 })
}

async function removeCreatedWorktree(page: Page, worktreeId: string): Promise<void> {
  await page.evaluate(async (id) => {
    await window.__store?.getState().removeWorktree(id, true)
  }, worktreeId)
}

test('creates a worktree, keeps its terminal isolated, and switches back @golden', async ({
  mcodePage
}) => {
  test.setTimeout(180_000)
  await waitForSessionReady(mcodePage)
  const originalWorktreeId = await waitForActiveWorktree(mcodePage)
  await waitForActiveTerminalManager(mcodePage, 30_000)
  const parentPtyId = await waitForActivePanePtyId(mcodePage)
  const workspaceName = `golden-switch-${Date.now()}`
  let childWorktreeId: string | null = null

  try {
    await createWorkspace(mcodePage, workspaceName)
    await expect(
      mcodePage.locator('[role="option"][aria-current="page"]').filter({ hasText: workspaceName })
    ).toBeVisible({ timeout: 30_000 })
    childWorktreeId = await waitForActiveWorktree(mcodePage)
    // Why: the cleanup force-removes childWorktreeId, so it must never resolve to the original.
    expect(childWorktreeId).not.toBe(originalWorktreeId)
    await expect(
      mcodePage.locator(`[role="option"][data-worktree-id="${childWorktreeId}"]`)
    ).toHaveAttribute('aria-current', 'page')

    await createTerminalTabFromMenu(mcodePage)
    await waitForActiveTerminalManager(mcodePage, 30_000)
    const childPtyId = await waitForActivePanePtyId(mcodePage)
    expect(childPtyId).not.toBe(parentPtyId)
    await waitForPtyShellEcho(mcodePage, childPtyId, 15_000)
    await execInTerminal(mcodePage, childPtyId, splitMarkerEchoCommand('worktree', '-b'))
    await waitForTerminalOutput(mcodePage, 'worktree-b')

    await mcodePage.locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`).click()
    await expect(
      mcodePage.locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`)
    ).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
    await waitForActiveTerminalManager(mcodePage, 30_000)
    expect(await waitForActivePanePtyId(mcodePage, 30_000)).toBe(parentPtyId)
  } finally {
    if (childWorktreeId) {
      if ((await getActiveWorktreeId(mcodePage).catch(() => null)) !== originalWorktreeId) {
        await mcodePage
          .locator(`[role="option"][data-worktree-id="${originalWorktreeId}"]`)
          .click()
          .catch(() => undefined)
      }
      await removeCreatedWorktree(mcodePage, childWorktreeId).catch(() => undefined)
    }
  }
})
