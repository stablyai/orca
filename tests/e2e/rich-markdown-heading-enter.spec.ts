import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

for (const kind of ['git', 'folder'] as const) {
  test(`Enter inside a heading creates a saved paragraph in a ${kind} workspace`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const folderPath =
      kind === 'folder' ? mkdtempSync(path.join(os.tmpdir(), 'orca-heading-enter-')) : null
    if (folderPath) {
      registerPostElectronShutdownCleanup(async () =>
        rmSync(folderPath, { recursive: true, force: true })
      )
      await orcaPage.evaluate(async (folderPath) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Missing fixture store')
        }
        const group = await window.api.projectGroups.create({
          name: 'Heading fixture',
          parentPath: folderPath,
          createdFrom: 'folder-scan'
        })
        await state.fetchProjectGroups()
        const folder = await state.createFolderWorkspace({
          projectGroupId: group.id,
          name: 'Heading document',
          folderPath
        })
        if (!folder) {
          throw new Error('Missing fixture folder')
        }
        state.setActiveWorktree(`folder:${folder.id}`)
      }, folderPath)
    }
    const workspace = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      const id = state?.activeWorktreeId
      if (!state || !id) {
        throw new Error('Missing active workspace')
      }
      const git = Object.values(state.worktreesByRepo)
        .flat()
        .find((worktree) => worktree.id === id)
      const folder = state.folderWorkspaces.find((workspace) => `folder:${workspace.id}` === id)
      const root = git?.path ?? folder?.folderPath
      if (!root) {
        throw new Error('Missing workspace root')
      }
      return { id, root }
    })
    const filePath = path.join(workspace.root, 'heading-enter.md')
    writeFileSync(filePath, '## Section Two\n\nTail.\n')
    await orcaPage.evaluate(
      ({ workspace, filePath }) => {
        window.__store?.getState().openFile({
          worktreeId: workspace.id,
          filePath,
          relativePath: 'heading-enter.md',
          language: 'markdown',
          mode: 'edit'
        })
      },
      { workspace, filePath }
    )
    const editor = orcaPage.locator('.tiptap.ProseMirror')
    await expect(editor.locator('h2')).toHaveText('Section Two')
    await expect(editor).toBeFocused()
    // Mount focus queues another frame before the caret is ready for typing.
    await orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        )
    )
    await editor.locator('h2').evaluate((heading) => {
      const text = heading.firstChild
      if (!(text instanceof Text)) {
        throw new Error('Missing heading text')
      }
      const range = document.createRange()
      range.setStart(text, 8)
      range.collapse(true)
      const selection = document.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
      document.dispatchEvent(new Event('selectionchange'))
    })
    await orcaPage.keyboard.press('Enter')
    await orcaPage.screenshot({
      path: testInfo.outputPath(`heading-enter-${kind}.png`),
      animations: 'disabled'
    })
    await expect(editor.locator('h2')).toHaveCount(1)
    await expect(editor.locator('h2')).toHaveText('Section')
    await expect(editor.locator('p').filter({ hasText: /^Two$/ })).toHaveCount(1)
    await expect(editor.locator('p').filter({ hasText: /^Tail\.$/ })).toHaveCount(1)
    const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
    await orcaPage.keyboard.press(`${isMac ? 'Meta' : 'Control'}+z`)
    await expect(editor.locator('h2')).toHaveText('Section Two')
    await expect(editor.locator('p').filter({ hasText: /^Two$/ })).toHaveCount(0)
    await orcaPage.keyboard.press(`${isMac ? 'Meta' : 'Control'}+Shift+z`)
    await expect(editor.locator('h2')).toHaveText('Section')
    await expect(editor.locator('p').filter({ hasText: /^Two$/ })).toHaveCount(1)
    await expect(editor).toBeFocused()
    await expect
      .poll(() =>
        editor.evaluate((root) => {
          const selection = document.getSelection()
          const text = selection?.anchorNode
          return (
            selection?.isCollapsed === true &&
            selection.anchorOffset === 0 &&
            text instanceof Text &&
            text.parentElement?.closest('p')?.textContent === 'Two' &&
            root.contains(text)
          )
        })
      )
      .toBe(true)
    await orcaPage.keyboard.press('Backspace')
    await expect(editor.locator('h2')).toHaveText('Section Two')
    await orcaPage.keyboard.press('Enter')
    await expect(editor.locator('h2')).toHaveText('Section')
    await expect(editor.locator('p').filter({ hasText: /^Two$/ })).toHaveCount(1)
    await orcaPage.keyboard.press(`${isMac ? 'Meta' : 'Control'}+s`)
    await expect.poll(() => readFileSync(filePath, 'utf8')).toBe('## Section \n\nTwo\n\nTail.\n')
    expect(readFileSync(filePath, 'utf8')).not.toContain('## Two')
    await testInfo.attach('saved-heading.md', {
      body: readFileSync(filePath),
      contentType: 'text/markdown'
    })
  })
}
