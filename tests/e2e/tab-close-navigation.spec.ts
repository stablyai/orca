// #693/#532: editor/diff close must select the exact surviving visual neighbor.
// #677: closing the final visible surface must deselect the workspace and return to Landing.

import { test, expect } from './helpers/orca-app'
import {
  waitForSessionReady,
  waitForActiveWorktree,
  getActiveWorktreeId,
  getActiveTabType,
  getOpenFiles,
  ensureTerminalVisible
} from './helpers/store'

// Take worktreeId explicitly because draining setup surfaces can deactivate the workspace.
async function openSeededEditorTabs(
  page: Parameters<typeof getActiveWorktreeId>[0],
  worktreeId: string,
  relativePaths: string[]
): Promise<string[]> {
  return page.evaluate(
    ({ wId, relPaths }) => {
      const store = window.__store
      if (!store) {
        return []
      }

      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id === wId)
      if (!worktree) {
        return []
      }

      const separator = worktree.path.includes('\\') ? '\\' : '/'
      const ids: string[] = []
      for (const relPath of relPaths) {
        const filePath = `${worktree.path}${separator}${relPath}`
        state.openFile({
          filePath,
          relativePath: relPath,
          worktreeId: wId,
          language: relPath.endsWith('.md')
            ? 'markdown'
            : relPath.endsWith('.json')
              ? 'json'
              : relPath.endsWith('.ts')
                ? 'typescript'
                : 'plaintext',
          mode: 'edit'
        })
        const latest = store.getState().openFiles.find((f) => f.filePath === filePath)
        if (latest) {
          ids.push(latest.id)
        }
      }
      return ids
    },
    { wId: worktreeId, relPaths: relativePaths }
  )
}

async function setActiveFile(
  page: Parameters<typeof getActiveWorktreeId>[0],
  fileId: string
): Promise<void> {
  await page.evaluate((id) => {
    const store = window.__store
    if (!store) {
      return
    }

    const state = store.getState()
    state.setActiveFile(id)
    state.setActiveTabType('editor', state.activeWorktreeId)
  }, fileId)
}

async function closeFile(
  page: Parameters<typeof getActiveWorktreeId>[0],
  fileId: string
): Promise<void> {
  await page.evaluate((id) => {
    window.__store?.getState().closeFile(id)
  }, fileId)
}

async function getActiveFileId(
  page: Parameters<typeof getActiveWorktreeId>[0]
): Promise<string | null> {
  return page.evaluate(() => window.__store?.getState().activeFileId ?? null)
}

test.describe('Tab Close Navigation', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  // #693: choose the next visual neighbor after a middle editor close.
  test('closing the active editor tab activates its visual neighbor', async ({ orcaPage }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)

    const fileIds = await openSeededEditorTabs(orcaPage, worktreeId, [
      'package.json',
      'README.md',
      'tsconfig.json'
    ])
    expect(fileIds.length).toBe(3)

    // Close the middle of package/README/tsconfig so tsconfig is the required successor.
    await setActiveFile(orcaPage, fileIds[1])
    await expect.poll(async () => getActiveFileId(orcaPage), { timeout: 3_000 }).toBe(fileIds[1])

    await closeFile(orcaPage, fileIds[1])

    const openFilesAfter = await getOpenFiles(orcaPage, worktreeId)
    const remainingIds = new Set(openFilesAfter.map((f) => f.id))
    expect(remainingIds.has(fileIds[1])).toBe(false)

    // Require tsconfig’s exact id; any-open-file assertions miss stale or arbitrarily chosen selection (#693).
    await expect
      .poll(async () => getActiveFileId(orcaPage), {
        timeout: 5_000,
        message: 'expected the visual neighbor (tsconfig.json) to become active after close'
      })
      .toBe(fileIds[2])

    // Keep editor view while other files remain.
    await expect.poll(async () => getActiveTabType(orcaPage), { timeout: 3_000 }).toBe('editor')
  })

  // Diffs share closeFile/openFiles ordering and must select the same visual neighbor (#693).
  test('closing the active diff tab activates a still-open neighbor', async ({ orcaPage }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)

    const editorIds = await openSeededEditorTabs(orcaPage, worktreeId, [
      'package.json',
      'README.md'
    ])
    expect(editorIds.length).toBe(2)

    const diffId = await orcaPage.evaluate((wId) => {
      const store = window.__store
      if (!store) {
        return null
      }

      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id === wId)
      if (!worktree) {
        return null
      }

      const separator = worktree.path.includes('\\') ? '\\' : '/'
      state.openDiff(
        wId,
        `${worktree.path}${separator}src${separator}index.ts`,
        `src${separator}index.ts`,
        'typescript',
        false
      )
      return store.getState().activeFileId
    }, worktreeId)

    expect(diffId).not.toBeNull()
    await expect.poll(async () => getActiveFileId(orcaPage), { timeout: 3_000 }).toBe(diffId)

    await closeFile(orcaPage, diffId!)

    const openFilesAfter = await getOpenFiles(orcaPage, worktreeId)
    const remainingIds = new Set(openFilesAfter.map((f) => f.id))
    expect(remainingIds.has(diffId!)).toBe(false)
    expect(remainingIds.size).toBe(2)

    // The final diff closes at index 2, so require the exact preceding README id (#693).
    await expect
      .poll(async () => getActiveFileId(orcaPage), {
        timeout: 5_000,
        message: 'expected README.md (last remaining) to become active after closing the diff tab'
      })
      .toBe(editorIds[1])
  })

  // #677: no terminal/browser/editor surface means activeWorktreeId must clear.
  test('closing the last visible surface returns the app to Landing', async ({ orcaPage }) => {
    const worktreeId = await waitForActiveWorktree(orcaPage)

    // Drain terminal/browser surfaces, then reactivate to seed the final editor; last-surface cleanup can deselect during setup.
    await orcaPage.evaluate((wId) => {
      const store = window.__store
      if (!store) {
        return
      }

      const state = store.getState()
      // Drain terminal rows even while editor view is active.
      for (const tab of state.tabsByWorktree[wId] ?? []) {
        state.closeTab(tab.id)
      }

      for (const bt of state.browserTabsByWorktree[wId] ?? []) {
        state.closeBrowserTab(bt.id)
      }

      if (store.getState().activeWorktreeId !== wId) {
        store.getState().setActiveWorktree(wId)
      }
    }, worktreeId)

    const editorIds = await openSeededEditorTabs(orcaPage, worktreeId, ['package.json'])
    expect(editorIds.length).toBe(1)

    await setActiveFile(orcaPage, editorIds[0])
    await expect.poll(async () => getActiveFileId(orcaPage), { timeout: 3_000 }).toBe(editorIds[0])

    // Re-close late startup terminals inside the poll, then require no backing surfaces before testing editor-only deactivation.
    await expect
      .poll(
        () =>
          orcaPage.evaluate((wId) => {
            const store = window.__store
            if (!store) {
              throw new Error('window.__store is not available')
            }
            const state = store.getState()
            for (const tab of state.tabsByWorktree[wId] ?? []) {
              state.closeTab(tab.id)
            }
            for (const bt of state.browserTabsByWorktree[wId] ?? []) {
              state.closeBrowserTab(bt.id)
            }
            const next = store.getState()
            return {
              terminals: (next.tabsByWorktree[wId] ?? []).length,
              browserTabs: (next.browserTabsByWorktree[wId] ?? []).length
            }
          }, worktreeId),
        {
          timeout: 15_000,
          message: 'terminal/browser surfaces did not drain before last-editor close'
        }
      )
      .toEqual({ terminals: 0, browserTabs: 0 })

    await closeFile(orcaPage, editorIds[0])

    await expect
      .poll(async () => getActiveWorktreeId(orcaPage), {
        timeout: 5_000,
        message: 'activeWorktreeId was not cleared after closing the last visible surface'
      })
      .toBeNull()
  })
})
