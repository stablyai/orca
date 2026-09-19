import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  activateGoldenWorktree,
  cleanupGoldenWorktree,
  createGoldenWorktree
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const HEBREW_FILE = 'rtl-notes.txt'
// Line 1 mixes an RTL run with a trailing LTR run: the two swap visual order when the
// paragraph's base direction flips, which is the only thing that actually proves bidi
// reordering happened rather than mere re-alignment.
const BIDI_LINE = 'שלום עולם ABC'
const HEBREW_CONTENT = `${BIDI_LINE}\nconst answer = 42\nמרחבא بالعالم\n`

test('reveals and applies the RTL text-direction toggle for a Hebrew file', async ({
  orcaPage,
  testRepoPath,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const fixture = createGoldenWorktree(testRepoPath, 'rtl-direction')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const filePath = path.join(fixture.worktreePath, HEBREW_FILE)
  writeFileSync(filePath, HEBREW_CONTENT, 'utf8')

  await waitForSessionReady(orcaPage)
  await activateGoldenWorktree(orcaPage, testRepoPath, fixture.worktreePath)
  const worktreeId = await orcaPage.evaluate(
    () => window.__store?.getState().activeWorktreeId ?? null
  )
  expect(worktreeId).toBeTruthy()

  const fileId = await orcaPage.evaluate(
    ({ absolutePath, relativePath, wId }) => {
      const state = window.__store?.getState()
      state?.openFile({
        filePath: absolutePath,
        relativePath,
        worktreeId: wId,
        language: 'plaintext',
        mode: 'edit'
      })
      return (
        window.__store?.getState().openFiles.find((file) => file.filePath === absolutePath)?.id ??
        null
      )
    },
    { absolutePath: filePath, relativePath: HEBREW_FILE, wId: String(worktreeId) }
  )
  expect(fileId).toBeTruthy()

  const monaco = orcaPage.locator('.monaco-editor').first()
  await expect(monaco).toBeVisible({ timeout: 25_000 })
  await expect(orcaPage.locator('.view-line').first()).toContainText('שלום', { timeout: 20_000 })

  // Measure where line 1's text sits inside the lines container. Alignment is the effect this
  // feature actually produces, so assert that rather than the CSS class alone.
  const lineTextAlignment = async (): Promise<'left' | 'right'> =>
    orcaPage.evaluate(() => {
      const container = document.querySelector('.view-lines')
      const view = document.querySelector('.view-line')
      if (!container || !view) {
        throw new Error('no rendered lines')
      }
      const range = document.createRange()
      range.selectNodeContents(view)
      const text = range.getBoundingClientRect()
      const box = container.getBoundingClientRect()
      return text.left - box.left <= box.right - text.right ? 'left' : 'right'
    })

  // Alignment alone cannot tell `direction: rtl` from a bare `text-align: right`, and would not
  // notice 'auto' doing nothing, so pair it with the computed style that must be in effect.
  const lineDirectionStyle = async (): Promise<{ direction: string; unicodeBidi: string }> =>
    orcaPage.evaluate(() => {
      const view = document.querySelector('.view-line')
      if (!view) {
        throw new Error('no rendered lines')
      }
      const style = getComputedStyle(view)
      return { direction: style.direction, unicodeBidi: style.unicodeBidi }
    })

  expect(await lineTextAlignment()).toBe('left')
  expect(await lineDirectionStyle()).toMatchObject({ direction: 'ltr' })

  // The toggle only appears because the file holds strong RTL text.
  const directionButton = orcaPage.getByRole('button', { name: 'Text Direction' })
  await expect(directionButton).toBeVisible({ timeout: 20_000 })
  await expect(directionButton).toHaveAttribute('aria-pressed', 'false')
  await expect(orcaPage.locator('.editor-dir-rtl')).toHaveCount(0)

  const ltrShot = testInfo.outputPath('editor-direction-ltr.png')
  await monaco.screenshot({ path: ltrShot })
  await testInfo.attach('editor-direction-ltr', { path: ltrShot, contentType: 'image/png' })

  await directionButton.click()

  await expect(directionButton).toHaveAttribute('aria-pressed', 'true')
  await expect(orcaPage.locator('.editor-dir-rtl')).toHaveCount(1)
  expect(
    await orcaPage.evaluate(
      (id) => window.__store?.getState().editorTextDirectionByFile[id],
      fileId
    )
  ).toBe('rtl')

  // The visible effect of 'rtl': the document's lines become flush right.
  expect(await lineTextAlignment()).toBe('right')
  // Proves the lines really carry `direction: rtl`, not just an alignment change.
  expect(await lineDirectionStyle()).toMatchObject({ direction: 'rtl' })

  const rtlShot = testInfo.outputPath('editor-direction-rtl.png')
  await monaco.screenshot({ path: rtlShot })
  await testInfo.attach('editor-direction-rtl', { path: rtlShot, contentType: 'image/png' })

  // The caret must actually land in RTL, not merely accept the pointer event: Orca mirrors
  // Monaco's cursor line into the store, so assert it moved to the clicked line.
  await orcaPage.evaluate((id) => {
    window.__store?.getState().setEditorCursorLine(id, 1)
  }, fileId)
  await orcaPage.locator('.view-line').nth(1).click()
  await expect
    .poll(
      () => orcaPage.evaluate((id) => window.__store?.getState().editorCursorLine[id], fileId),
      { timeout: 10_000 }
    )
    .toBe(2)

  // Toggling back drops the override rather than pinning an explicit 'ltr'.
  await directionButton.click()
  await expect(directionButton).toHaveAttribute('aria-pressed', 'false')
  await expect(orcaPage.locator('.editor-dir-rtl')).toHaveCount(0)
  expect(
    await orcaPage.evaluate(
      (id) => window.__store?.getState().editorTextDirectionByFile[id] ?? null,
      fileId
    )
  ).toBeNull()

  // With no per-file override left, the global 'auto' default takes over and
  // each line picks its own base direction from its first strong character.
  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ editorTextDirection: 'auto' })
  })
  await expect(orcaPage.locator('.editor-dir-auto')).toHaveCount(1)
  await expect(orcaPage.locator('.editor-dir-rtl')).toHaveCount(0)
  // 'auto' sets each line's base direction from its first strong character without right-aligning,
  // so alignment stays left while the class is applied.
  expect(await lineTextAlignment()).toBe('left')
  // Asserting `unicode-bidi: plaintext` is what stops this passing when 'auto' does nothing.
  expect(await lineDirectionStyle()).toMatchObject({
    direction: 'ltr',
    unicodeBidi: 'plaintext'
  })

  const autoShot = testInfo.outputPath('editor-direction-auto.png')
  await monaco.screenshot({ path: autoShot })
  await testInfo.attach('editor-direction-auto', { path: autoShot, contentType: 'image/png' })

  await orcaPage.evaluate(async () => {
    await window.__store?.getState().updateSettings({ editorTextDirection: 'ltr' })
  })
  await expect(orcaPage.locator('.editor-dir-auto')).toHaveCount(0)
})
