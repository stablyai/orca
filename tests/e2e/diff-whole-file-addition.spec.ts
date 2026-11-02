import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  GOLDEN_CHANGED_PATH,
  openGoldenSourceControl,
  seedGoldenSourceEdit
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

const NEW_FILE_PATH = 'src/brand-new.ts'
const TRANSPARENT = 'rgba(0, 0, 0, 0)'

const DIFF_TINT_SELECTOR = [
  '.line-insert',
  '.char-insert',
  '.gutter-insert',
  '.line-delete',
  '.char-delete',
  '.gutter-delete',
  '.inline-deleted-margin-view-zone'
].join(', ')

function diffTintBackgrounds(diff: Locator): Promise<string[]> {
  return diff
    .locator(`:is(${DIFF_TINT_SELECTOR})`)
    .evaluateAll((lines) => lines.map((line) => getComputedStyle(line).backgroundColor))
}

async function expectAddedTint(diff: Locator, tinted: boolean): Promise<void> {
  await expect
    .poll(async () => await diff.locator('.modified-in-monaco-diff-editor .line-insert').count())
    .toBeGreaterThan(0)
  const backgrounds = await diffTintBackgrounds(diff)
  if (tinted) {
    expect(backgrounds.some((background) => background !== TRANSPARENT)).toBe(true)
  } else {
    expect(backgrounds.every((background) => background === TRANSPARENT)).toBe(true)
  }
}

for (const surface of ['file', 'combined'] as const) {
  test(`${surface} diff leaves wholly new files untinted and keeps edits tinted`, async ({
    orcaPage,
    testRepoPath,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const fixture = createGoldenWorktree(testRepoPath, `diff-whole-file-addition-${surface}`)
    registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
    seedGoldenSourceEdit(fixture.worktreePath)
    writeFileSync(
      path.join(fixture.worktreePath, NEW_FILE_PATH),
      Array.from({ length: 12 }, (_, line) => `export const fresh${line} = ${line}\n`).join('')
    )

    await waitForSessionReady(orcaPage)
    await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
    const entry = (filePath: string): Locator =>
      orcaPage
        .locator('[data-testid="source-control-entry"]')
        .filter({ hasText: path.basename(filePath) })

    if (surface === 'file') {
      const diff = orcaPage.locator('.monaco-diff-editor:visible')
      await entry(NEW_FILE_PATH).click()
      await expect(diff).toBeVisible({ timeout: 20_000 })
      await orcaPage.screenshot({ path: testInfo.outputPath('new-file.png') })
      await expectAddedTint(diff, false)

      await entry(GOLDEN_CHANGED_PATH).click()
      await expect(
        diff.locator('.modified-in-monaco-diff-editor .view-line').filter({ hasText: 'golden' })
      ).toBeVisible({ timeout: 20_000 })
      await orcaPage.screenshot({ path: testInfo.outputPath('edited-file.png') })
      await expectAddedTint(diff, true)
      return
    }

    await expect(entry(NEW_FILE_PATH)).toBeVisible({ timeout: 15_000 })
    await orcaPage
      .getByRole('button', { name: /^Changes \d+$/ })
      .locator('..')
      .getByRole('button', { name: 'View all', exact: true })
      .click()
    const section = (filePath: string): Locator =>
      orcaPage
        .locator('[data-combined-diff-section-row]')
        .filter({ hasText: path.basename(filePath) })
        .locator('.monaco-diff-editor')
    await expect(section(NEW_FILE_PATH)).toBeVisible({ timeout: 20_000 })
    await expect(section(GOLDEN_CHANGED_PATH)).toBeVisible({ timeout: 20_000 })
    await orcaPage.screenshot({ path: testInfo.outputPath('combined.png') })
    await expectAddedTint(section(NEW_FILE_PATH), false)
    await expectAddedTint(section(GOLDEN_CHANGED_PATH), true)
  })
}
