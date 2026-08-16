import path from 'node:path'
import { test, expect } from './helpers/orca-app'

const CHECKPOINT_ERROR = 'Renderer shutdown checkpoint was not completed.'

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
    async ({ filePath, worktreeId }) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const originalHistory = state.browserUrlHistory
      state.browserUrlHistory = [
        { url: null, title: 'corrupt persisted history', lastVisitedAt: 0 }
      ] as unknown as typeof state.browserUrlHistory
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
      worktreeId: await orcaPage.evaluate(() => window.__store?.getState().activeWorktreeId ?? '')
    }
  )

  expect(dirtyResult).toBe(CHECKPOINT_ERROR)

  const cleanResult = await orcaPage.evaluate(async () => {
    const store = window.__store
    if (!store) {
      throw new Error('window.__store is not available')
    }
    const state = store.getState()
    const originalHistory = state.browserUrlHistory
    state.browserUrlHistory = [
      { url: null, title: 'corrupt persisted history', lastVisitedAt: 0 }
    ] as unknown as typeof state.browserUrlHistory
    try {
      await window.api.updater.quitAndInstall()
      return 'continued'
    } catch (error) {
      return String((error as Error)?.message ?? error)
    } finally {
      state.browserUrlHistory = originalHistory
    }
  })

  expect(cleanResult).toBe('continued')
  expect(fallbackLogs).toHaveLength(1)
})
