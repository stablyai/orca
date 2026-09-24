import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'

function readRootVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (variable) => getComputedStyle(document.documentElement).getPropertyValue(variable).trim(),
    name
  )
}

function setCustomCssEnabled(page: Page, enabled: boolean): Promise<void> {
  return page.evaluate(async (customCssEnabled) => {
    await window.__store?.getState().updateSettings({ customCssEnabled })
  }, enabled)
}

test.describe('custom.css', () => {
  test('overrides the theme, follows saves, and never loads remote resources', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    const cssPath = await orcaPage.evaluate(async () => (await window.api.customCss.get()).path)
    // The fixture isolates HOME under a realpath'd temp dir; never write into the real ~/.orca.
    expect(cssPath.startsWith(realpathSync.native(os.tmpdir()))).toBe(true)
    mkdirSync(path.dirname(cssPath), { recursive: true })

    const stock = {
      background: await readRootVar(orcaPage, '--background'),
      foreground: await readRootVar(orcaPage, '--foreground'),
      sidebar: await readRootVar(orcaPage, '--sidebar')
    }

    writeFileSync(cssPath, ':root, .dark { --background: #ff0000; }')
    await setCustomCssEnabled(orcaPage, true)
    await expect.poll(() => readRootVar(orcaPage, '--background')).toBe('#ff0000')
    // Beats main.css at equal specificity, down to the painted surface.
    await expect
      .poll(() => orcaPage.evaluate(() => getComputedStyle(document.body).backgroundColor))
      .toBe('rgb(255, 0, 0)')

    writeFileSync(
      cssPath,
      [
        '@import url("data:text/css,:root{--foreground:%23123456}");',
        '@property --remote-img { syntax: "<image>"; inherits: false; initial-value: url(https://example.com/p.png); }',
        `html { background-image: url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>"); }`,
        ':root, .dark { --background: #00ff00; --sidebar: u\\72l(h\\74tps://example.com/x.png); }',
        'body { background-image: url(h\\74tps://example.com/y.png); }',
        ':root, .dark { --split-scheme: url("htt\\9 ps://example.com/beacon.png"); }',
        ':root, .dark { --unc-path: url(\\\\server\\share\\x.png); }',
        ':root, .dark { --relative-image: url(wallpaper.png); }'
      ].join('\n')
    )
    await expect.poll(() => readRootVar(orcaPage, '--background')).toBe('#00ff00')
    expect(await readRootVar(orcaPage, '--foreground')).toBe(stock.foreground)
    expect(await readRootVar(orcaPage, '--sidebar')).toBe(stock.sidebar)
    // A surviving @property would expose its remote initial-value on every element.
    expect(await readRootVar(orcaPage, '--remote-img')).toBe('')
    expect(await orcaPage.evaluate(() => getComputedStyle(document.body).backgroundImage)).toBe(
      'none'
    )
    // Chromium removes the escaped tab and folds `\` to `/` before resolving, so both would fetch if kept.
    expect(await readRootVar(orcaPage, '--split-scheme')).toBe('')
    expect(await readRootVar(orcaPage, '--unc-path')).toBe('')
    // A relative URL resolves against the renderer origin, which is HTTP in development.
    expect(await readRootVar(orcaPage, '--relative-image')).toBe('')
    // A local inline SVG is not a fetch and must survive.
    expect(
      await orcaPage.evaluate(() => getComputedStyle(document.documentElement).backgroundImage)
    ).toContain('data:image/svg+xml')

    await setCustomCssEnabled(orcaPage, false)
    await expect.poll(() => readRootVar(orcaPage, '--background')).toBe(stock.background)
  })
})
