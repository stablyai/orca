import { rmSync, writeFileSync } from 'node:fs'
import { diffTextSelectionPoints } from './diff-text-selection'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { addAndActivateRepo } from './helpers/isolated-repo-activation'
import { createIsolatedLargeDiffRepo } from './large-diff-repro-fixtures'

test.use({ seedTestRepo: false })
test('copies backwards selections with file and line context from each diff side', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}) => {
  const original = 'export const one = 1\nexport const two = 2\nexport const three = 3\n'
  const fixture = createIsolatedLargeDiffRepo(original)
  registerPostElectronShutdownCleanup(async () =>
    rmSync(fixture.repoPath, { recursive: true, force: true })
  )
  const modified = original.replaceAll('= ', '= 9')
  writeFileSync(fixture.absolutePath, modified)
  // Why pinned: side-by-side panes are half the window, and these tests drag across whole
  // lines. A narrower CI display than a dev window leaves no scroll position that exposes
  // both endpoints, so the drag silently lands on the sticky line-number column.
  await orcaPage.setViewportSize({ width: 1600, height: 900 })
  await waitForSessionReady(orcaPage)
  await addAndActivateRepo(orcaPage, fixture.repoPath)
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({ diffDefaultView: 'side-by-side' })
  )
  await orcaPage.getByRole('button', { name: /^Source Control/ }).click()
  await orcaPage.locator('[data-testid="source-control-entry"]').first().click()
  await expect(orcaPage.locator('diffs-container [data-content] [data-line]').first()).toBeVisible({
    timeout: 20_000
  })
  const previousClipboard = await electronApp.evaluate(({ clipboard }) => clipboard.readText())
  let copied = ''
  try {
    for (const side of ['deletions', 'additions']) {
      const contents = side === 'deletions' ? original : modified
      const coordinates = await diffTextSelectionPoints(
        orcaPage.locator(`diffs-container [data-code][data-${side}]`),
        contents.trimEnd()
      )
      await orcaPage.mouse.move(coordinates.end.x, coordinates.end.y)
      await orcaPage.mouse.down()
      await orcaPage.mouse.move(coordinates.start.x, coordinates.start.y, { steps: 8 })
      await orcaPage.mouse.up()
      await expect
        .poll(() =>
          orcaPage
            .locator('diffs-container')
            .evaluate((host) =>
              (host.shadowRoot as ShadowRoot & { getSelection(): Selection })
                .getSelection()
                .toString()
            )
        )
        .toBe(contents.trimEnd())
      await orcaPage.keyboard.press('ControlOrMeta+Alt+c')
      copied = `File: ${fixture.relativePath}\nLines: 1-3\n\n\`\`\`ts\n${contents}\`\`\``
      await expect
        .poll(() => electronApp.evaluate(({ clipboard }) => clipboard.readText()))
        .toBe(copied)
      await expect(orcaPage.getByText('Context copied', { exact: true }).first()).toBeVisible()
    }
  } finally {
    await electronApp.evaluate(
      ({ clipboard }, { copied, previousClipboard }) => {
        if (clipboard.readText() === copied) {
          clipboard.writeText(previousClipboard)
        }
      },
      { copied, previousClipboard }
    )
  }
})
