import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page, TestInfo } from '@stablyai/playwright-test'

export async function seedMultiwindowSearch(orcaPage: Page, testInfo: TestInfo) {
  const folder = testInfo.outputPath('search-folder')
  mkdirSync(folder, { recursive: true })
  const filePath = path.join(folder, 'search-draft.md')
  const notesPath = path.join(folder, 'destination-notes.md')
  writeFileSync(filePath, '# Search draft\n\nOriginal\n')
  writeFileSync(notesPath, '# Destination notes\n')
  const fixture = await orcaPage.evaluate(
    async ({ folder, filePath }) => {
      const state = window.__store!.getState()
      const original = state.activeWorktreeId!
      const terminal = state.tabsByWorktree[original]?.[0] ?? state.createTab(original)
      state.setTabCustomTitle(terminal.id, 'PANE4 search shell')
      const repo = await state.addNonGitFolder(folder)
      const folderId = window.__store!.getState().worktreesByRepo[repo!.id]![0]!.id
      state.openFile({
        worktreeId: folderId,
        filePath,
        relativePath: 'search-draft.md',
        language: 'markdown',
        mode: 'edit'
      })
      const seeded = window.__store!.getState().windowPaneLayout!
      for (const pane of Object.values(seeded.panes)) {
        for (const id of pane.viewIds) {
          if (seeded.views[id].worktreeId === folderId) {
            state.closeWorkspaceView(pane.id, id)
          }
        }
      }
      return { original, folderId, terminalId: terminal.id }
    },
    { folder, filePath }
  )
  return { fixture, filePath, notesPath }
}
