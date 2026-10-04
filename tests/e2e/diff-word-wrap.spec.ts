import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { waitForSessionReady } from './helpers/store'

type DiffSurface = 'file' | 'combined'

async function toggleWordWrap(page: Page, surface: DiffSurface): Promise<void> {
  if (surface === 'combined') {
    await page.getByRole('button', { name: /^Wrap (On|Off)$/ }).click()
    return
  }
  await page.getByRole('button', { name: 'More actions', exact: true }).click()
  await page.getByRole('menuitemcheckbox', { name: 'Word Wrap', exact: true }).click()
}

async function expectWrappedParagraphs(page: Page): Promise<void> {
  for (const side of ['original', 'modified']) {
    const pane = page.locator(`.${side}-in-monaco-diff-editor`)
    await expect
      .poll(() => pane.locator('.view-line').count(), {
        message: `${side} paragraphs should occupy multiple wrapped rows`
      })
      .toBeGreaterThan(10)
    await expect
      .poll(() =>
        pane.evaluate((element) => {
          const viewport = element.querySelector('.monaco-scrollable-element')
          if (!viewport) {
            throw new Error('Missing Monaco text viewport')
          }
          const textWidth = Math.max(
            ...Array.from(
              element.querySelectorAll('.view-line > span'),
              (line) => line.getBoundingClientRect().width
            )
          )
          return textWidth - viewport.getBoundingClientRect().width
        })
      )
      .toBeLessThanOrEqual(1)
  }
}

for (const surface of ['file', 'combined'] as const) {
  test(`${surface} diff word wrap applies to both panes after toggles and narrow inline layout`, async ({
    orcaPage,
    testRepoPath,
    registerPostElectronShutdownCleanup
  }, testInfo) => {
    const fixture = createGoldenWorktree(testRepoPath, `diff-word-wrap-${surface}`)
    registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
    const paragraph =
      'This long Markdown paragraph compares the original and modified panes at their own widths. '.repeat(
        9
      )
    const readmePath = path.join(fixture.worktreePath, 'README.md')
    const content = `# Diff word wrap\n\n${paragraph}Original paragraph end.\n\n${paragraph}Second original paragraph end.\n`
    writeFileSync(readmePath, content)
    execFileSync('git', ['add', 'README.md'], { cwd: fixture.worktreePath, stdio: 'pipe' })
    execFileSync('git', ['commit', '-m', 'Seed long Markdown paragraphs'], {
      cwd: fixture.worktreePath,
      stdio: 'pipe'
    })
    writeFileSync(
      readmePath,
      content.replaceAll('original', 'modified').replaceAll('Original', 'Modified')
    )

    await orcaPage.setViewportSize({ width: 1600, height: 850 })
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(async () => {
      await window.__store?.getState().updateSettings({
        diffDefaultView: 'side-by-side',
        diffWordWrap: false
      })
    })
    await openGoldenSourceControl(orcaPage, testRepoPath, fixture)
    const changes = orcaPage.getByRole('button', { name: /^Changes \d+$/ }).locator('..')
    await (
      surface === 'combined'
        ? changes.getByRole('button', { name: 'View all', exact: true })
        : changes
            .locator('../..')
            .locator('[data-testid="source-control-entry"]')
            .filter({ hasText: 'README.md' })
    ).click()
    await orcaPage.evaluate(() => window.__store?.getState().setRightSidebarOpen(false))
    const diff = orcaPage.locator('.monaco-diff-editor')
    await expect(diff).toHaveClass(/side-by-side/)
    await toggleWordWrap(orcaPage, surface)
    await orcaPage.screenshot({ path: testInfo.outputPath('wrap-on.png') })
    await expectWrappedParagraphs(orcaPage)

    await orcaPage.setViewportSize({ width: 1000, height: 850 })
    await expect(diff).not.toHaveClass(/side-by-side/)
    await orcaPage.setViewportSize({ width: 1600, height: 850 })
    await expect(diff).toHaveClass(/side-by-side/)
    await expectWrappedParagraphs(orcaPage)

    await toggleWordWrap(orcaPage, surface)
    for (const side of ['original', 'modified']) {
      await expect
        .poll(() => orcaPage.locator(`.${side}-in-monaco-diff-editor .view-line`).count())
        .toBeLessThanOrEqual(6)
    }
    await toggleWordWrap(orcaPage, surface)
    await expectWrappedParagraphs(orcaPage)
  })
}
