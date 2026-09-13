import { rmSync, writeFileSync } from 'node:fs'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { addAndActivateRepo } from './helpers/isolated-repo-activation'
import { createIsolatedLargeDiffRepo } from './large-diff-repro-fixtures'

test.use({ seedTestRepo: false })
test('renders wrap, whitespace, layout, font and theme changes in a narrow diff', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  const original = `export const oldName = 1\n  export const indented = 2\nexport const wide = '${'long text '.repeat(60)}'\n`
  const fixture = createIsolatedLargeDiffRepo(original)
  registerPostElectronShutdownCleanup(async () =>
    rmSync(fixture.repoPath, { recursive: true, force: true })
  )
  writeFileSync(
    fixture.absolutePath,
    original.replace('oldName', 'newName').replace('  export', '    export')
  )
  await waitForSessionReady(orcaPage)
  await orcaPage.setViewportSize({ width: 1280, height: 900 })
  await addAndActivateRepo(orcaPage, fixture.repoPath)
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({
      theme: 'light',
      diffDefaultView: 'side-by-side',
      diffWordWrap: false,
      diffShowWhitespace: false,
      terminalFontSize: 13
    })
  )
  await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
  await orcaPage.getByRole('button', { name: 'View all', exact: true }).first().click()
  const host = orcaPage.locator('diffs-container').first()
  const code = host.locator('[data-code][data-additions]')
  const wide = code.locator('[data-line]').filter({ hasText: 'export const wide' })
  await expect(wide).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(() => code.evaluate((node) => node.scrollWidth - node.clientWidth))
    .toBeGreaterThan(500)
  const initialHeight = await wide.evaluate((node) => node.getBoundingClientRect().height)
  await expect(
    host.locator('[data-line][data-line-type="change-addition"]').filter({ hasText: 'indented' })
  ).toHaveCount(0)
  await orcaPage.getByRole('button', { name: 'Whitespace Off', exact: true }).click()
  await expect(
    host.locator('[data-line][data-line-type="change-addition"]').filter({ hasText: 'indented' })
  ).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Wrap Off', exact: true }).click()
  await expect
    .poll(() => wide.evaluate((node) => node.getBoundingClientRect().height))
    .toBeGreaterThan(initialHeight * 2)
  await expect
    .poll(() => code.evaluate((node) => node.scrollWidth - node.clientWidth))
    .toBeLessThan(3)
  await orcaPage.getByRole('button', { name: 'Inline', exact: true }).click()
  await expect(host.locator('[data-code][data-deletions]')).toHaveCount(0)
  await expect(host.locator('[data-line]').filter({ hasText: 'oldName' })).toBeVisible()
  await expect(host.locator('[data-line]').filter({ hasText: 'newName' })).toBeVisible()
  await orcaPage.evaluate(() => {
    window.__store!.getState().setEditorFontZoomLevel(2)
    return window
      .__store!.getState()
      .updateSettings({ theme: 'dark', editorFontFamily: 'Courier New' })
  })
  const row = host.locator('[data-content] [data-line]').first()
  await expect.poll(() => row.evaluate((node) => getComputedStyle(node).fontSize)).toBe('14.5px')
  await expect
    .poll(() => row.evaluate((node) => getComputedStyle(node).fontFamily))
    .toContain('Courier New')
  await expect
    .poll(() =>
      row.evaluate((node) =>
        getComputedStyle(node).getPropertyValue('--diffs-editor-selection-bg').trim()
      )
    )
    .toBe('#264f78')
  await orcaPage.screenshot({ path: testInfo.outputPath('dark-wrapped-inline-diff.png') })
})
