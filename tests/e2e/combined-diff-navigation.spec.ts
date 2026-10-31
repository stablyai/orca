import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  cleanupGoldenWorktree,
  createGoldenWorktree,
  openGoldenSourceControl
} from './helpers/golden-source-control'
import { pressShortcut } from './helpers/shortcuts'
import { waitForSessionReady } from './helpers/store'

test('combined diff caps rendering and reveals unchanged Find targets while preserving go-to cancellation', async ({
  orcaPage: page,
  testRepoPath,
  registerPostElectronShutdownCleanup
}) => {
  const fixture = createGoldenWorktree(testRepoPath, 'combined-navigation')
  registerPostElectronShutdownCleanup(async () => cleanupGoldenWorktree(testRepoPath, fixture))
  const files = ['clip-a.ts', 'clip-b.ts']
  const content = (version: string) =>
    `${Array.from(
      { length: 1000 },
      (_, i) => `export const value${i} = '${version}-${i === 19 ? 'soleNeedle' : i}'`
    ).join('\n')}\n`
  for (const file of files) {
    writeFileSync(path.join(fixture.worktreePath, file), content('old'))
  }
  execFileSync('git', ['add', '--', ...files], { cwd: fixture.worktreePath, stdio: 'pipe' })
  execFileSync('git', ['commit', '-m', 'Seed combined navigation files'], {
    cwd: fixture.worktreePath,
    stdio: 'pipe'
  })
  for (const file of files) {
    writeFileSync(path.join(fixture.worktreePath, file), content('new'))
  }
  await waitForSessionReady(page)
  await page.setViewportSize({ width: 1600, height: 900 })
  await page.evaluate(() =>
    window.__store
      ?.getState()
      .updateSettings({ diffDefaultView: 'side-by-side', diffWordWrap: false })
  )
  await openGoldenSourceControl(page, testRepoPath, fixture)
  await page
    .getByRole('button', { name: /^Changes \d+$/ })
    .locator('..')
    .getByRole('button', { name: 'View all', exact: true })
    .click()
  await page.evaluate(() => window.__store?.getState().setRightSidebarOpen(false))
  const viewport = page.locator('[data-combined-diff-viewport]:visible')
  const row = page
    .locator('[data-combined-diff-section-row]:visible')
    .filter({ has: page.getByText('clip-b.ts', { exact: true }) })
  // Mount the following row, then leave only its first 80px in the viewport.
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight
  })
  await expect(row.locator('.monaco-diff-editor')).toHaveCount(1)
  await expect
    .poll(() => row.locator('.modified-in-monaco-diff-editor .view-line').count())
    .toBeGreaterThan(10)
  await expect.poll(async () => (await row.boundingBox())?.height ?? 0).toBeGreaterThan(10_000)
  const partial = async () =>
    row.evaluate((element) => {
      const outer = element.closest<HTMLElement>('[data-combined-diff-viewport]')
      if (!outer) {
        throw new Error('missing combined viewport')
      }
      outer.dispatchEvent(new WheelEvent('wheel', { bubbles: true }))
      outer.scrollTop +=
        element.getBoundingClientRect().top -
        outer.getBoundingClientRect().top -
        outer.clientHeight +
        80
      outer.dispatchEvent(new Event('scroll'))
      return outer.scrollTop
    })
  await partial()
  await expect
    .poll(() =>
      row.evaluate((element) => {
        const outer = element.closest<HTMLElement>('[data-combined-diff-viewport]')
        const editor = element.querySelector('.monaco-diff-editor')
        if (!outer || !editor) {
          return false
        }
        return (
          editor.getBoundingClientRect().height <= outer.clientHeight &&
          element.querySelectorAll('.view-line').length < 180
        )
      })
    )
    .toBe(true)
  const input = row.locator('.modified-in-monaco-diff-editor textarea.inputarea')
  await input.focus()
  const replaceShortcut = await page.evaluate(() =>
    navigator.userAgent.includes('Mac') ? 'Meta+Alt+f' : 'Control+h'
  )
  await page.keyboard.press(replaceShortcut)
  await expect
    .poll(() =>
      row.locator('.modified-in-monaco-diff-editor .find-widget').evaluate((element) => {
        const outer = element.closest<HTMLElement>('[data-combined-diff-viewport]')
        if (!outer) {
          return false
        }
        const rect = element.getBoundingClientRect()
        const bounds = outer.getBoundingClientRect()
        return rect.height > 40 && rect.top >= bounds.top && rect.bottom <= bounds.bottom
      })
    )
    .toBe(true)
  await page.keyboard.press('Escape')
  await partial()
  await input.focus()
  await pressShortcut(page, 'f')
  const find = row.locator('.find-widget .monaco-inputbox').first().locator('textarea, input')
  await find.fill('soleNeedle')
  await find.press('Enter')
  const targetIsVisible = () =>
    row.evaluate((element) => {
      const outer = element.closest<HTMLElement>('[data-combined-diff-viewport]')
      const header = element.querySelector('[data-combined-diff-section-header]')
      const target = [
        ...element.querySelectorAll('.modified-in-monaco-diff-editor .view-line')
      ].find((line) => line.textContent?.includes('soleNeedle'))
      if (!outer || !target || !header) {
        return false
      }
      const rect = target.getBoundingClientRect()
      const bounds = outer.getBoundingClientRect()
      return (
        rect.top >= bounds.top + header.getBoundingClientRect().height &&
        rect.bottom <= bounds.top + outer.clientHeight
      )
    })
  await expect.poll(targetIsVisible).toBe(true)
  // The sole active match stays unchanged; only the explicit request can reveal it again.
  await partial()
  await expect.poll(targetIsVisible).toBe(false)
  await find.press('Enter')
  await expect.poll(targetIsVisible).toBe(true)
  await partial()
  await pressShortcut(page, 'f')
  await expect
    .poll(() =>
      find.evaluate((element) => {
        const outer = element.closest('[data-combined-diff-viewport]')
        if (!outer) {
          return false
        }
        const rect = element.getBoundingClientRect()
        const bounds = outer.getBoundingClientRect()
        return rect.top >= bounds.top && rect.bottom <= bounds.bottom
      })
    )
    .toBe(true)
  await find.press('Escape')
  await input.focus()
  const original = await partial()
  await page.keyboard.press('Control+g')
  const picker = page.locator('.quick-input-widget input')
  await expect(picker).toBeVisible()
  await picker.fill(':300')
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(original + 100)
  await picker.press('Escape')
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeCloseTo(original, 0)
})
