import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { addAndActivateRepo } from './helpers/isolated-repo-activation'
import { createIsolatedLargeDiffRepo } from './large-diff-repro-fixtures'

test.use({ seedTestRepo: false })
for (const mode of ['editable-file', 'readonly-combined']) {
  test(`finds both sides and preserves edit permissions in ${mode}`, async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const original = `export const oldOnly = 1\n${Array.from({ length: 599 }, (_, index) => `export const value${index} = ${index}\n`).join('')}`
    const modified = `// inserted line\n${original.replace('oldOnly', 'newOnly')}`
    const fixture = createIsolatedLargeDiffRepo(original)
    registerPostElectronShutdownCleanup(async () =>
      rmSync(fixture.repoPath, { recursive: true, force: true })
    )
    writeFileSync(fixture.absolutePath, modified)
    await waitForSessionReady(orcaPage)
    await addAndActivateRepo(orcaPage, fixture.repoPath)
    await orcaPage.evaluate(
      (readonly) =>
        window.__store!.getState().updateSettings({
          diffDefaultView: readonly ? 'inline' : 'side-by-side',
          diffWordWrap: false
        }),
      mode === 'readonly-combined'
    )
    await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
    if (mode === 'readonly-combined') {
      await orcaPage.getByRole('button', { name: 'Stage All', exact: true }).click()
      await expect(
        orcaPage.locator('[data-testid="source-control-entry"][data-source-control-area="staged"]')
      ).toHaveCount(1)
      await orcaPage.getByRole('button', { name: 'View all', exact: true }).first().click()
    } else {
      await orcaPage.locator('[data-testid="source-control-entry"]').first().click()
    }
    const host = orcaPage.locator('diffs-container').first()
    const originalRow = host
      .locator('[data-code] [data-line][data-line-type="change-deletion"]')
      .first()
    await originalRow.click({ timeout: 20_000 })
    await orcaPage.keyboard.press('ControlOrMeta+f')
    const search = orcaPage.locator('[data-diff-search]')
    const input = search.getByRole('textbox', { name: 'Find in diff', exact: true })
    await expect(input).toBeFocused()
    await expect(search.getByRole('button', { name: 'Original', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    await input.fill('oldOnly')
    await expect(search.getByRole('status')).toHaveText('1/1')
    await expect(search.getByRole('button', { name: 'Toggle replace', exact: true })).toHaveCount(0)
    await search.getByRole('button', { name: 'Use regular expression', exact: true }).click()
    await input.fill('value44[89]')
    await expect(search.getByRole('status')).toHaveText('1/2')
    await input.press('F3')
    await expect(search.getByRole('status')).toHaveText('2/2')
    await input.press('Shift+F3')
    await expect(search.getByRole('status')).toHaveText('1/2')
    await search.getByRole('button', { name: 'Use regular expression', exact: true }).click()
    await input.fill('value448')
    await expect(search.getByRole('status')).toHaveText('1/1')
    await expect(
      host.locator('[data-code] [data-line]').filter({ hasText: 'value448 = 448' }).first()
    ).toBeInViewport()
    await orcaPage.screenshot({ path: testInfo.outputPath(`${mode}-original-search.png`) })
    await search.getByRole('button', { name: 'Modified', exact: true }).click()
    await input.fill('newOnly')
    await expect(search.getByRole('status')).toHaveText('1/1')
    if (mode === 'readonly-combined') {
      await expect(host.locator('[contenteditable="true"]')).toHaveCount(0)
      await expect(search.getByRole('button', { name: 'Toggle replace', exact: true })).toHaveCount(
        0
      )
      const row = host
        .locator('[data-code] [data-line][data-line-type="change-addition"]')
        .filter({ hasText: 'newOnly' })
      await search.getByRole('button', { name: 'Close search', exact: true }).click()
      await row.click()
      await orcaPage.keyboard.type('CORRUPTED')
      await expect(row).toHaveText('export const newOnly = 1\n')
      expect(readFileSync(fixture.absolutePath, 'utf8')).toBe(modified)
    } else {
      await search.getByRole('button', { name: 'Use regular expression', exact: true }).click()
      await input.fill('new(Only)')
      await search.getByRole('button', { name: 'Toggle replace', exact: true }).click()
      await search.getByRole('textbox', { name: 'Replace in diff', exact: true }).fill('changed$1')
      await expect(search.getByRole('status')).toHaveText('1/1')
      await search.getByRole('button', { name: 'Replace all', exact: true }).click()
      const row = host
        .locator('[data-code][data-additions] [data-line]')
        .filter({ hasText: 'changedOnly' })
      await expect(row).toBeVisible()
      await search.getByRole('button', { name: 'Close search', exact: true }).click()
      await orcaPage.keyboard.press('ControlOrMeta+z')
      await expect(host.locator('[data-code][data-additions]')).toContainText('newOnly')
      await orcaPage.keyboard.press('ControlOrMeta+s')
      await expect.poll(() => readFileSync(fixture.absolutePath, 'utf8')).toBe(modified)
    }
  })
}

test('cancels a pathological regex without blocking input', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createIsolatedLargeDiffRepo('export const before = 1\n')
  registerPostElectronShutdownCleanup(async () =>
    rmSync(fixture.repoPath, { recursive: true, force: true })
  )
  writeFileSync(fixture.absolutePath, `export const after = 1\n// ${'a'.repeat(80)}!\n`)
  await waitForSessionReady(orcaPage)
  await addAndActivateRepo(orcaPage, fixture.repoPath)
  await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
  await orcaPage.locator('[data-testid="source-control-entry"]').first().click()
  const host = orcaPage.locator('diffs-container').first()
  await host
    .locator('[data-code] [data-line][data-line-type="change-addition"]')
    .first()
    .click({ timeout: 20_000 })
  await orcaPage.keyboard.press('ControlOrMeta+f')
  const search = orcaPage.locator('[data-diff-search]')
  const input = search.getByRole('textbox', { name: 'Find in diff', exact: true })
  await search.getByRole('button', { name: 'Use regular expression', exact: true }).click()
  await orcaPage.evaluate(() => {
    let last = performance.now()
    const probe = { maxLag: 0, timer: 0 }
    probe.timer = window.setInterval(() => {
      const now = performance.now()
      probe.maxLag = Math.max(probe.maxLag, now - last - 20)
      last = now
    }, 20)
    ;(window as unknown as { diffSearchProbe: typeof probe }).diffSearchProbe = probe
  })
  await input.fill('(a+)+$')
  await expect(search.getByRole('status')).toContainText('Search took too long', { timeout: 8_000 })
  await input.fill('(a+)+!$')
  await expect(search.getByRole('status')).toHaveText('1/1', { timeout: 3_000 })
  await input.fill('(a+)+$')
  await orcaPage.waitForTimeout(300)
  await input.fill('after')
  await expect(search.getByRole('status')).toHaveText('1/1', { timeout: 3_000 })
  const maxLag = await orcaPage.evaluate(() => {
    const probe = (window as unknown as { diffSearchProbe: { timer: number; maxLag: number } })
      .diffSearchProbe
    clearInterval(probe.timer)
    return probe.maxLag
  })
  expect(maxLag).toBeLessThan(1_000)
})
