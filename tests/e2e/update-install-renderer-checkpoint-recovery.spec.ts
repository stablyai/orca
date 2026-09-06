import path from 'node:path'
import { test, expect } from './helpers/orca-app'

// Only the prefix is contract: the checkpoint error appends the swallowed persist
// cause (STA-5505), whose wording belongs to whatever threw.
const CHECKPOINT_ERROR_PREFIX = 'Renderer shutdown checkpoint was not completed: '

// The null url is injected, never hydrated: the desktop session schema drops such a row, and
// no other arrival path carries browserUrlHistory at all (paired web reads it unvalidated but
// has no producer — STA-5668 follow-up). It is just a deterministic snapshot-build failure.
const CORRUPT_HISTORY_ENTRY = { url: null, title: 'corrupt persisted history', lastVisitedAt: 0 }

test('recovers update install from a corrupt clean session but preserves dirty drafts', async ({
  orcaPage,
  testRepoPath
}) => {
  const fallbackLogs: string[] = []
  orcaPage.on('console', (message) => {
    if (message.text().includes('Full renderer session snapshot failed; using durable session')) {
      fallbackLogs.push(message.text())
    }
  })

  const dirtyResult = await orcaPage.evaluate(
    async ({ filePath, worktreeId, corruptEntry }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const originalHistory = state.browserUrlHistory
      state.browserUrlHistory = [corruptEntry] as unknown as typeof state.browserUrlHistory
      const fileId = state.openFile({
        filePath,
        relativePath: 'checkpoint-draft.txt',
        worktreeId,
        language: 'plaintext',
        mode: 'edit'
      })
      state.setEditorDraft(fileId, 'unsaved draft')
      state.markFileDirty(fileId, true)

      try {
        await window.api.updater.quitAndInstall()
        return null
      } catch (error) {
        return String((error as Error)?.message ?? error)
      } finally {
        state.markFileDirty(fileId, false)
        state.closeFile(fileId)
        state.browserUrlHistory = originalHistory
      }
    },
    {
      filePath: path.join(testRepoPath, 'checkpoint-draft.txt'),
      worktreeId: await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId ?? ''),
      corruptEntry: CORRUPT_HISTORY_ENTRY
    }
  )

  expect(dirtyResult).toContain(CHECKPOINT_ERROR_PREFIX)
  // Pin the cause to the corrupt row, not just any named failure; only the member name
  // survives V8 rewording of "Cannot read properties of null".
  expect(dirtyResult).toContain('toLowerCase')

  const cleanResult = await orcaPage.evaluate(async (corruptEntry) => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const originalHistory = state.browserUrlHistory
    state.browserUrlHistory = [corruptEntry] as unknown as typeof state.browserUrlHistory
    try {
      await window.api.updater.quitAndInstall()
      return 'continued'
    } catch (error) {
      return String((error as Error)?.message ?? error)
    } finally {
      state.browserUrlHistory = originalHistory
    }
  }, CORRUPT_HISTORY_ENTRY)

  expect(cleanResult).toBe('continued')
  expect(fallbackLogs).toHaveLength(1)
})
