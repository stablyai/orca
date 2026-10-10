import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const cases = [
  { extension: 'tsx', indent: '    ' },
  { extension: 'jsx', indent: '    ' },
  { extension: 'tsx', indent: '' },
  { extension: 'jsx', indent: '' },
  { extension: 'ts', indent: '' },
  { extension: 'js', indent: '' }
] as const

for (const { extension, indent } of cases) {
  const jsx = extension === 'tsx' || extension === 'jsx'
  const title = jsx
    ? `uses JSX comment syntax for a child element in ${extension}${indent ? '' : ' without indentation'}`
    : `keeps native line comments and readonly safety in ${extension}`
  test(title, async ({ orcaPage, testRepoPath, registerPostElectronShutdownCleanup }, testInfo) => {
    const fixture = createGoldenWorktree(testRepoPath, `jsx-comment-${extension}`)
    registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
    const source = jsx
      ? ['const view = (', '  <section>', `${indent}<h1>Hello</h1>`, '  </section>', ')'].join('\n')
      : 'const answer = 42'
    const target = jsx ? '<h1>Hello</h1>' : source
    const filePath = path.join(fixture.worktreePath, `Card.${extension}`)
    writeFileSync(filePath, source)
    await waitForSessionReady(orcaPage)
    await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
    await orcaPage.evaluate(
      ({ filePath, relativePath, language }) => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        if (!state || !worktreeId) {
          throw new Error('JSX fixture worktree unavailable')
        }
        state.openFile({ filePath, relativePath, worktreeId, language, mode: 'edit' })
      },
      {
        filePath,
        relativePath: path.basename(filePath),
        language: extension.startsWith('ts') ? 'typescript' : 'javascript'
      }
    )
    const editor = orcaPage.locator('.monaco-editor').first()
    await expect(editor.locator('.view-lines')).toContainText(target)
    await editor.click()
    await orcaPage.keyboard.press('ControlOrMeta+f')
    await editor.locator('.find-widget .input[aria-label="Find"]').fill(target)
    await orcaPage.keyboard.press('Enter')
    await orcaPage.keyboard.press('Escape')
    await expect
      .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().selection))
      .toMatchObject({
        selectionStartLineNumber: jsx ? 3 : 1,
        selectionStartColumn: jsx ? indent.length + 1 : 1,
        positionLineNumber: jsx ? 3 : 1,
        positionColumn: jsx ? indent.length + 15 : 18
      })
    await orcaPage.keyboard.press('ControlOrMeta+/')
    await expect(editor.locator('.view-lines')).toContainText(
      jsx ? '{/* <h1>Hello</h1> */}' : '// const answer = 42'
    )
    await orcaPage.screenshot({ path: testInfo.outputPath('jsx-child-comment.png') })
    if (jsx) {
      await orcaPage.keyboard.press('ControlOrMeta+/')
      await expect
        .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot().valueLength))
        .toBe(source.length)
      await expect(editor.locator('.view-lines')).not.toContainText('{/*')
      await orcaPage.keyboard.press('ControlOrMeta+z')
      await expect(editor.locator('.view-lines')).toContainText('{/* <h1>Hello</h1> */}')
    }
    await orcaPage.keyboard.press('ControlOrMeta+z')
    await expect
      .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot()))
      .toMatchObject({ valueLength: source.length, canUndo: false })
    await expect(editor.locator('.view-lines')).not.toContainText(jsx ? '{/*' : '//')
    await orcaPage.evaluate((filePath) => {
      const store = window.__store
      if (!store) {
        throw new Error('JSX fixture store unavailable')
      }
      store.setState({
        openFiles: store
          .getState()
          .openFiles.map((file) =>
            file.filePath === filePath ? { ...file, readOnly: true } : file
          )
      })
    }, filePath)
    await expect(editor.locator('textarea.ime-text-area')).toHaveAttribute('readonly', 'true')
    await orcaPage.keyboard.press('ControlOrMeta+/')
    await expect
      .poll(() => orcaPage.evaluate(() => window.__monacoEditorE2E?.snapshot()))
      .toMatchObject({ valueLength: source.length, canUndo: false })
  })
}
