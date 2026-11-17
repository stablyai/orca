import { rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { addAndActivateRepo } from './helpers/isolated-repo-activation'
import { createIsolatedLargeDiffRepo } from './large-diff-repro-fixtures'

test.use({ seedTestRepo: false })
for (const layout of ['side-by-side', 'inline'] as const) {
  test(`note gutter supports modified ranges in ${layout} diffs`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const original = 'export const one = 1\nexport const two = 2\nexport const three = 3\n'
    const fixture = createIsolatedLargeDiffRepo(original)
    registerPostElectronShutdownCleanup(async () =>
      rmSync(fixture.repoPath, { recursive: true, force: true })
    )
    writeFileSync(fixture.absolutePath, original.replaceAll('= ', '= 9'))
    await waitForSessionReady(orcaPage)
    await addAndActivateRepo(orcaPage, fixture.repoPath)
    await orcaPage.evaluate(
      (diffDefaultView) => window.__store!.getState().updateSettings({ diffDefaultView }),
      layout
    )
    await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
    await orcaPage.locator('[data-testid="source-control-entry"]').first().click()
    const host = orcaPage.locator('diffs-container')
    const originalLine = host.locator('[data-content] [data-line-type="change-deletion"]').first()
    const modifiedLine = host.locator('[data-content] [data-line-type="change-addition"]').first()
    const addButton = host.getByRole('button', { name: 'Add note for the AI', exact: true })
    await originalLine.hover({ timeout: 20_000 })
    await expect(host.locator('[data-utility-button]')).toHaveCount(0)
    await modifiedLine.hover()
    await expect(addButton).toBeVisible()
    const buttonBox = await addButton.boundingBox()
    const lastNumber = host.locator('[data-column-number="3"][data-line-type="change-addition"]')
    const lastBox = await lastNumber.boundingBox()
    if (!buttonBox || !lastBox) {
      throw new Error('Missing gutter layout')
    }
    await orcaPage.mouse.move(buttonBox.x + buttonBox.width / 2, buttonBox.y + buttonBox.height / 2)
    await orcaPage.mouse.down()
    await orcaPage.mouse.move(lastBox.x + lastBox.width / 2, lastBox.y + lastBox.height / 2, {
      steps: 5
    })
    await orcaPage.mouse.up()
    const draft = host.locator('.orca-diff-comment-popover-textarea')
    await expect(draft).toBeVisible()
    await draft.fill('Review these three modified lines')
    await host.getByRole('button', { name: 'Add note', exact: true }).click()
    const card = host.locator('.orca-diff-comment-card')
    await expect(card).toContainText('Review these three modified lines')
    await expect(card).toContainText('Note lines 1-3')
    await orcaPage.screenshot({ path: testInfo.outputPath(`${layout}-range-note.png`) })
  })
}
