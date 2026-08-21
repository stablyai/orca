import type { Page, TestInfo } from '@stablyai/playwright-test'
import { expect, test } from './helpers/mcode-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const NOTE_LINE = 6
const INITIAL_ZONE_HEIGHT = 88
const FOLLOWING_LINE = 'export const line07 = "following-line-marker"'
const NOTE_BODY =
  'This saved note is intentionally one long paragraph so it wraps across several visual lines in narrow and wide diff layouts without adding newline characters to the initial zone estimate.'

async function assertCardClearsFollowingLine(page: Page): Promise<void> {
  const card = page.locator('.mcode-diff-comment-card').first()
  const followingLine = page
    .locator('.modified-in-monaco-diff-editor .view-lines .view-line')
    .filter({ hasText: FOLLOWING_LINE })
    .first()

  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(followingLine).toBeVisible({ timeout: 15_000 })
  await expect
    .poll(async () => (await card.boundingBox())?.height ?? 0)
    .toBeGreaterThan(INITIAL_ZONE_HEIGHT)
  await expect
    .poll(
      async () => {
        const [cardBox, lineBox] = await Promise.all([
          card.boundingBox(),
          followingLine.boundingBox()
        ])
        return cardBox && lineBox ? lineBox.y - (cardBox.y + cardBox.height) : -1
      },
      { message: 'saved note overlaps the following diff line' }
    )
    .toBeGreaterThanOrEqual(0)
}

async function attachDiffScreenshot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const diff = page.locator('.monaco-diff-editor').first()
  const screenshotPath = testInfo.outputPath(`${name}.png`)
  await diff.screenshot({ path: screenshotPath })
  await testInfo.attach(name, { path: screenshotPath, contentType: 'image/png' })
}

test.describe('Diff note layout', () => {
  test.beforeEach(async ({ mcodePage }) => {
    await waitForSessionReady(mcodePage)
    await waitForActiveWorktree(mcodePage)
  })

  test('saved notes reserve their rendered height in both diff layouts', async ({
    mcodePage
  }, testInfo) => {
    await mcodePage.setViewportSize({ width: 1200, height: 800 })
    const worktreeId = await waitForActiveWorktree(mcodePage)
    const relativePath = await mcodePage.evaluate(async (wId) => {
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      const state = store.getState()
      const worktree = Object.values(state.worktreesByRepo)
        .flat()
        .find((entry) => entry.id === wId)
      if (!worktree) {
        throw new Error('active worktree not found')
      }
      const separator = worktree.path.includes('\\') ? '\\' : '/'
      const relative = `src${separator}diff-note-layout.ts`
      const lines = Array.from({ length: 14 }, (_, index) => {
        const number = String(index + 1).padStart(2, '0')
        const value = index + 1 === 7 ? 'following-line-marker' : `value-${number}`
        return `export const line${number} = "${value}"`
      })
      await window.api.fs.writeFile({
        filePath: `${worktree.path}${separator}${relative}`,
        content: `${lines.join('\n')}\n`
      })
      await state.updateSettings({ diffDefaultView: 'side-by-side' })
      return relative
    }, worktreeId)

    const added = await mcodePage.evaluate(
      ({ wId, filePath, lineNumber, body }) =>
        window.__store?.getState().addDiffComment({
          worktreeId: wId,
          filePath,
          source: 'diff',
          lineNumber,
          body,
          side: 'modified'
        }),
      { wId: worktreeId, filePath: relativePath, lineNumber: NOTE_LINE, body: NOTE_BODY }
    )
    expect(added, 'addDiffComment returned null').not.toBeNull()

    await mcodePage.evaluate(
      ({ wId, filePath }) => {
        const state = window.__store?.getState()
        const worktree = Object.values(state?.worktreesByRepo ?? {})
          .flat()
          .find((entry) => entry.id === wId)
        if (!state || !worktree) {
          throw new Error('active worktree not found')
        }
        const separator = worktree.path.includes('\\') ? '\\' : '/'
        state.openDiff(
          wId,
          `${worktree.path}${separator}${filePath}`,
          filePath,
          'typescript',
          false
        )
      },
      { wId: worktreeId, filePath: relativePath }
    )

    await expect(mcodePage.locator('button:has(svg.lucide-rows-2)')).toBeVisible()
    await assertCardClearsFollowingLine(mcodePage)
    await attachDiffScreenshot(mcodePage, testInfo, 'side-by-side-diff-note-layout')

    await mcodePage.evaluate(() =>
      window.__store?.getState().updateSettings({ diffDefaultView: 'inline' })
    )
    await expect(mcodePage.locator('button:has(svg.lucide-columns-2)')).toBeVisible()
    await assertCardClearsFollowingLine(mcodePage)
    await attachDiffScreenshot(mcodePage, testInfo, 'inline-diff-note-layout')
  })
})
