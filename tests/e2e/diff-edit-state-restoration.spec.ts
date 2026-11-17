import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { addAndActivateRepo } from './helpers/isolated-repo-activation'
import { createIsolatedLargeDiffRepo } from './large-diff-repro-fixtures'

test.use({ seedTestRepo: false })
for (const surface of ['file', 'combined']) {
  test(`restores horizontal scroll, selected text and undo history in a ${surface} diff`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const original = `export const message = "old-${'a'.repeat(400)}"\n`
    const modified = original.replace('old-', 'new-')
    const fixture = createIsolatedLargeDiffRepo(original)
    registerPostElectronShutdownCleanup(async () =>
      rmSync(fixture.repoPath, { recursive: true, force: true })
    )
    writeFileSync(fixture.absolutePath, modified)
    if (surface === 'file') {
      writeFileSync(path.join(fixture.repoPath, 'other.txt'), 'other file\n')
    }
    await waitForSessionReady(orcaPage)
    await addAndActivateRepo(orcaPage, fixture.repoPath)
    await orcaPage.evaluate(() =>
      window
        .__store!.getState()
        .updateSettings({ diffDefaultView: 'side-by-side', diffWordWrap: false })
    )
    await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
    const entry = orcaPage
      .locator('[data-testid="source-control-entry"]')
      .filter({ hasText: path.basename(fixture.relativePath) })
    const open =
      surface === 'file'
        ? entry
        : orcaPage.getByRole('button', { name: 'View all', exact: true }).first()
    await open.click()
    const host = orcaPage.locator('diffs-container').first()
    const line = host.locator('[data-content] [data-line-type="change-addition"]').first()
    await expect(line).toBeVisible({ timeout: 20_000 })
    const code = host.locator('[data-code][data-additions]')
    const codeBox = await code.boundingBox()
    if (!codeBox) {
      throw new Error('Missing diff viewport')
    }
    await orcaPage.mouse.move(codeBox.x + 120, codeBox.y + 10)
    await orcaPage.keyboard.down('Shift')
    await orcaPage.mouse.wheel(0, 120)
    await orcaPage.keyboard.up('Shift')
    await expect.poll(() => code.evaluate((node) => node.scrollLeft)).toBeGreaterThan(50)
    await code.evaluate((node) => {
      node.scrollLeft = 0
    })
    await line.click({ timeout: 20_000, position: { x: 12, y: 8 } })
    await orcaPage.keyboard.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End')
    await orcaPage.keyboard.type('X')
    await expect(line).toHaveText(`${modified.trimEnd()}X`)
    await orcaPage.keyboard.press('ControlOrMeta+s')
    await expect
      .poll(() => readFileSync(fixture.absolutePath, 'utf8'))
      .toBe(`${modified.trimEnd()}X\n`)
    await orcaPage.keyboard.press('Shift+ArrowLeft')
    const horizontalPosition = await host
      .locator('[data-code][data-additions]')
      .evaluate((code) => code.scrollLeft)
    expect(horizontalPosition).toBeGreaterThan(500)
    if (surface === 'file') {
      await orcaPage
        .locator('[data-testid="source-control-entry"]')
        .filter({ hasText: 'other.txt' })
        .click()
      await expect(host.locator('[data-content]')).toContainText('other file')
      await entry.click()
    } else {
      const header = orcaPage.locator('[data-combined-diff-section-row] .sticky').first()
      await header.click({ position: { x: 4, y: 8 } })
      await expect(orcaPage.locator('diffs-container')).toHaveCount(0)
      await header.click({ position: { x: 4, y: 8 } })
    }
    await expect(line).toHaveText(`${modified.trimEnd()}X`, { timeout: 20_000 })
    await expect
      .poll(() => host.locator('[data-code][data-additions]').evaluate((code) => code.scrollLeft))
      .toBeCloseTo(horizontalPosition, 0)
    await host.locator('[contenteditable="true"]').focus()
    await orcaPage.keyboard.type('Y')
    await expect(line).toHaveText(`${modified.trimEnd()}Y`)
    await orcaPage.keyboard.press('ControlOrMeta+z')
    await expect(line).toHaveText(`${modified.trimEnd()}X`)
    await orcaPage.keyboard.press('ControlOrMeta+z')
    await expect(line).toHaveText(modified.trimEnd())
    await orcaPage.screenshot({ path: testInfo.outputPath(`${surface}-restored-history.png`) })
    await orcaPage.keyboard.press('ControlOrMeta+s')
    await expect.poll(() => readFileSync(fixture.absolutePath, 'utf8')).toBe(modified)
    if (surface === 'file') {
      await orcaPage
        .locator('[data-testid="source-control-entry"]')
        .filter({ hasText: 'other.txt' })
        .click()
      await expect(host.locator('[data-content]')).toContainText('other file')
      writeFileSync(fixture.absolutePath, 'external replacement\n')
      await entry.click()
    } else {
      const header = orcaPage.locator('[data-combined-diff-section-row] .sticky').first()
      await header.click({ position: { x: 4, y: 8 } })
      await expect(orcaPage.locator('diffs-container')).toHaveCount(0)
      writeFileSync(fixture.absolutePath, 'external replacement\n')
      await header.click({ position: { x: 4, y: 8 } })
    }
    await expect(host.locator('[data-content]').last()).toContainText('external replacement', {
      timeout: 20_000
    })
  })
}
