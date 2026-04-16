import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'

/** Open the right sidebar file explorer and wait for store state to match. */
export async function openFileExplorer(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    // Why: hidden Electron runs do not reliably deliver Cmd/Ctrl+Shift+E or
    // expose the sidebar DOM in time for locator-based setup. Drive the same
    // store state the shortcut would update so file-open specs cover the
    // explorer workflow instead of hidden-window input timing.
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

/**
 * Open the first matching seeded file via the store.
 *
 * Why: the tests assert file-open behavior, not DOM tree rendering. Opening a
 * stable seeded file through the same editor store action avoids hidden-window
 * explorer DOM flakiness while still exercising Orca's editor tab model.
 */
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
