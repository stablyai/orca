import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

export async function openFileExplorer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    // Set the shortcut’s store state directly because hidden windows cannot reliably deliver the setup chord.
    state.setRightSidebarTab('explorer')
    state.setRightSidebarOpen(true)
  })
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          return Boolean(state?.rightSidebarOpen && state?.rightSidebarTab === 'explorer')
        }),
      { timeout: 3_000 }
    )
    .toBe(true)
}

// Use the production open-file store action to isolate editor behavior from hidden-window explorer timing.
export async function clickFileInExplorer(
  page: Page,
  candidates: string[]
): Promise<string | null> {
  return page.evaluate((candidateNames) => {
    const store = window.__store
    if (!store) {
      return null
    }

    const state = store.getState()
    const activeWorktreeId = state.activeWorktreeId
    if (!activeWorktreeId) {
      return null
    }

    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((entry) => entry.id === activeWorktreeId)
    if (!worktree) {
      return null
    }

    const separator = worktree.path.includes('\\') ? '\\' : '/'
    for (const fileName of candidateNames) {
      const filePath = `${worktree.path}${separator}${fileName}`
      state.openFile({
        filePath,
        relativePath: fileName,
        worktreeId: activeWorktreeId,
        language: fileName.endsWith('.md')
          ? 'markdown'
          : fileName.endsWith('.json')
            ? 'json'
            : fileName.endsWith('.ts')
              ? 'typescript'
              : 'plaintext',
        mode: 'edit'
      })
      return fileName
    }

    return null
  }, candidates)
}
