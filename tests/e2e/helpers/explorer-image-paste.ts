import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect } from './orca-app'
import { openFileExplorer } from './file-explorer'
import { waitForActiveWorktree, waitForSessionReady } from './store'

export async function prepareImagePasteFolder(page: Page, name: string) {
  await waitForSessionReady(page)
  await waitForActiveWorktree(page)
  await openFileExplorer(page)
  const root = await page.evaluate(() => {
    const state = window.__store!.getState()
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === state.activeWorktreeId)
    if (!worktree) {
      throw new Error('Active test worktree unavailable')
    }
    return worktree.path
  })
  const destination = path.join(root, name)
  await mkdir(destination)
  const row = (fileName: string) =>
    page.locator('[data-file-explorer-row]').filter({
      has: page.getByText(fileName, { exact: true })
    })
  await expect(row(name)).toBeVisible()
  return { destination, row, folder: row(name) }
}
