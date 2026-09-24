import { existsSync, mkdirSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { getStoreState, waitForSessionReady } from './helpers/store'

const MASKED_CURSOR_EMAIL = 'user@******.com'

async function installPersistentCursorEmailMask(page: Page): Promise<void> {
  await page.evaluate((maskedEmail) => {
    const apply = (): void => {
      const current = window.__store!.getState().rateLimits
      const cursor = current.cursor
      const email = cursor?.usageMetadata?.accountEmail
      if (!email || email === maskedEmail) {
        return
      }
      window.__store!.setState({
        rateLimits: {
          ...current,
          cursor: {
            ...cursor,
            usageMetadata: {
              ...cursor.usageMetadata,
              accountEmail: maskedEmail
            }
          }
        }
      })
    }
    apply()
    window.__store!.subscribe(apply)
  }, MASKED_CURSOR_EMAIL)
}

const REAL_CURSOR_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Cursor')
const REAL_CURSOR_DB = path.join(REAL_CURSOR_DIR, 'User', 'globalStorage', 'state.vscdb')
const PROOF_DIR = process.env.ORCA_CURSOR_USAGE_PROOF_DIR

test.describe('macOS Cursor desktop login', () => {
  test.skip(
    process.platform !== 'darwin' || !PROOF_DIR || !existsSync(REAL_CURSOR_DB),
    'opt-in macOS proof: set ORCA_CURSOR_USAGE_PROOF_DIR against a live Cursor desktop login'
  )

  test('shows Cursor usage from Application Support state.vscdb', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => {
      localStorage.setItem('orca.workspaceBoardMovedHintSeen.v1', 'true')
    })
    await orcaPage.getByRole('button', { name: 'Workspace board' }).click()
    await orcaPage.keyboard.press('Escape')
    const isolatedHome = await electronApp.evaluate(async ({ app }) => app.getPath('home'))
    const isolatedCursor = path.join(isolatedHome, 'Library', 'Application Support', 'Cursor')
    mkdirSync(path.dirname(isolatedCursor), { recursive: true })
    if (!existsSync(isolatedCursor)) {
      symlinkSync(REAL_CURSOR_DIR, isolatedCursor)
    }

    await orcaPage.evaluate(async () => {
      await window.__store!.getState().refreshRateLimits()
    })
    await expect
      .poll(
        async () =>
          orcaPage.evaluate(() => {
            const cursor = window.__store!.getState().rateLimits.cursor
            return {
              auth: window.__store!.getState().rateLimits.cursorAuthConfigured,
              status: cursor?.status ?? null,
              bucketCount: cursor?.buckets?.length ?? 0
            }
          }),
        { timeout: 30_000 }
      )
      .toEqual(expect.objectContaining({ auth: true, status: 'ok' }))
    const bucketCount = await orcaPage.evaluate(
      () => window.__store!.getState().rateLimits.cursor?.buckets?.length ?? 0
    )
    expect(bucketCount).toBeGreaterThan(0)

    await installPersistentCursorEmailMask(orcaPage)

    const proofDir = PROOF_DIR ?? testInfo.outputDir
    mkdirSync(proofDir, { recursive: true })

    async function setTheme(theme: 'light' | 'dark'): Promise<void> {
      await orcaPage.evaluate(async (next) => {
        await window.__store!.getState().updateSettings({ theme: next })
      }, theme)
      await expect
        .poll(() => orcaPage.evaluate(() => document.documentElement.classList.contains('dark')))
        .toBe(theme === 'dark')
    }

    async function setUsageMode(mode: 'verbose' | 'compact'): Promise<void> {
      await orcaPage.evaluate((next) => {
        window.__store!.getState().setStatusBarUsageMode(next)
      }, mode)
      await expect.poll(() => getStoreState<string>(orcaPage, 'statusBarUsageMode')).toBe(mode)
    }

    await setTheme('light')
    await setUsageMode('verbose')
    await expect(orcaPage.getByRole('button', { name: 'Usage' })).toBeVisible()
    await orcaPage.screenshot({
      path: path.join(proofDir, 'macos-statusbar-verbose-light.png'),
      animations: 'disabled'
    })

    await setUsageMode('compact')
    await orcaPage.screenshot({
      path: path.join(proofDir, 'macos-statusbar-compact-light.png'),
      animations: 'disabled'
    })

    await orcaPage.getByRole('button', { name: 'Usage' }).click()
    const cursorRow = orcaPage.getByText(/Cursor/).first()
    await expect(cursorRow).toBeVisible()
    await orcaPage.screenshot({
      path: path.join(proofDir, 'macos-roster-light.png'),
      animations: 'disabled'
    })
    await cursorRow.click()
    await expect(orcaPage.getByText(MASKED_CURSOR_EMAIL)).toBeVisible()
    await orcaPage.screenshot({
      path: path.join(proofDir, 'macos-cursor-menu-light.png'),
      animations: 'disabled'
    })
    await orcaPage.keyboard.press('Escape')
    await orcaPage.keyboard.press('Escape')

    await setTheme('dark')
    await setUsageMode('verbose')
    await orcaPage.screenshot({
      path: path.join(proofDir, 'macos-statusbar-verbose-dark.png'),
      animations: 'disabled'
    })
    await setUsageMode('compact')
    await orcaPage.screenshot({
      path: path.join(proofDir, 'macos-statusbar-compact-dark.png'),
      animations: 'disabled'
    })
    await orcaPage.getByRole('button', { name: 'Usage' }).click()
    await orcaPage
      .getByText(/Cursor/)
      .first()
      .click()
    await orcaPage.screenshot({
      path: path.join(proofDir, 'macos-cursor-menu-dark.png'),
      animations: 'disabled'
    })
    await orcaPage.keyboard.press('Escape')
    await orcaPage.keyboard.press('Escape')

    await orcaPage.evaluate(() => {
      const state = window.__store!.getState()
      state.openSettingsTarget({ pane: 'accounts', repoId: null, sectionId: 'accounts-cursor' })
      state.openSettingsPage()
    })
    await expect(orcaPage.locator('#accounts-cursor')).toBeVisible()
    await orcaPage.locator('#accounts-cursor').screenshot({
      path: path.join(proofDir, 'macos-accounts-cursor-dark.png'),
      animations: 'disabled'
    })
    await setTheme('light')
    await orcaPage.locator('#accounts-cursor').screenshot({
      path: path.join(proofDir, 'macos-accounts-cursor-light.png'),
      animations: 'disabled'
    })
  })
})
