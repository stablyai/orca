import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import {
  createRuntimeDesktopPairingOffer,
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

const HOST_NAME = 'Build server'
const LONG_HOST_NAME = 'Shared GPU build server in us-east-1'
const STATUS_BAR_HEIGHT = 28
// Use a nonexistent Keychain account: HOME isolation alone does not hide the user-keyed macOS Claude login.
const NO_CLAUDE_LOGIN_USER = 'orca-e2e-no-claude-login'

test.use({ orcaAppExtraEnv: { USER: NO_CLAUDE_LOGIN_USER } })

// Collect cropped screenshot evidence outside test output; full windows expose usernames in terminal prompts.
async function shootStatusBar(
  page: Page,
  name: string,
  outputPath: (name: string) => string,
  width = 520
): Promise<void> {
  const viewport = page.viewportSize()
  if (!viewport) {
    throw new Error('Client page has no viewport')
  }
  await page.screenshot({
    path: outputPathFor(name, outputPath),
    clip: {
      x: 0,
      y: viewport.height - STATUS_BAR_HEIGHT,
      width: Math.min(width, viewport.width),
      height: STATUS_BAR_HEIGHT
    }
  })
}

function outputPathFor(name: string, outputPath: (name: string) => string): string {
  return process.env.ORCA_E2E_SCREENSHOT_DIR
    ? path.join(process.env.ORCA_E2E_SCREENSHOT_DIR, name)
    : outputPath(name)
}

function minimaxChip(page: Page) {
  return page.locator('[data-usage-chip="minimax"]')
}

async function focusFirstServerWorktree(page: Page, environmentId: string): Promise<void> {
  // Why: a fresh client profile has no repos of its own, so every worktree it lists is the server's.
  await page.waitForFunction(
    () => (window.__store?.getState().allWorktrees().length ?? 0) > 0,
    null,
    {
      timeout: 60_000
    }
  )
  const worktreeId = await page.evaluate(
    () => window.__store?.getState().allWorktrees()[0]?.id ?? null
  )
  if (!worktreeId) {
    throw new Error('Paired client lost the server worktree')
  }
  await page.evaluate(
    ({ env, id }) => window.__store?.getState().setActiveWorktree(id, `runtime:${env}`),
    { env: environmentId, id: worktreeId }
  )
}

test('a provider set up only on this computer stays visible, greyed, under a server workspace', async ({
  sharedPage
}, testInfo) => {
  test.setTimeout(180_000)
  const outputPath = (name: string): string => testInfo.outputPath(name)
  let client: PairedElectronClient | undefined
  try {
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(sharedPage),
      testInfo,
      HOST_NAME,
      { extraEnv: { USER: NO_CLAUDE_LOGIN_USER } }
    )
    const { page, environmentId } = client
    await page.setViewportSize({ width: 1280, height: 800 })

    // A failing fetch still counts as set up, so a fake key needs no network.
    await page.evaluate(async () => {
      await window.api.minimaxCredentials.saveApiKey('e2e-fake-minimax-key')
      await window.__store?.getState().refreshRateLimits()
    })
    await page.waitForFunction(
      () => window.__store?.getState().rateLimits.minimaxApiKeyConfigured === true,
      null,
      { timeout: 30_000 }
    )

    // Why: a one-time sidebar hint overlays the usage popover in screenshots until it times out.
    await expect(page.getByText('Workspace board moved to the bottom bar')).toHaveCount(0, {
      timeout: 20_000
    })

    await page.evaluate(() => window.__store?.getState().setActiveWorktree(null))
    await expect(minimaxChip(page)).toBeVisible({ timeout: 30_000 })
    await expect(minimaxChip(page).locator('[title]')).toHaveCount(0)
    await shootStatusBar(page, '1-local-owner-minimax-meter.png', outputPath)

    await focusFirstServerWorktree(page, environmentId)
    const placeholder = minimaxChip(page).locator(`[title^="Not configured on ${HOST_NAME}"]`)
    await expect(placeholder).toBeVisible({ timeout: 60_000 })
    await expect(placeholder).toHaveAttribute(
      'title',
      `Not configured on ${HOST_NAME}\nIts sign-in is saved on this computer only.`
    )
    await expect(placeholder).toHaveText(`Not configured on ${HOST_NAME}`)
    await expect(page.getByText('Configure usage tracking')).toHaveCount(0)
    await expect(page.getByText(`No usage on ${HOST_NAME}`)).toHaveCount(0)
    await shootStatusBar(page, '2-server-owner-chip-short-host.png', outputPath)

    // A long host name truncates in the chip only; the tooltip keeps it whole.
    const renameHost = (name: string) =>
      page.evaluate(
        ({ env, name }) =>
          window.__store?.setState((state) => ({
            runtimeEnvironments: state.runtimeEnvironments.map((environment) =>
              environment.id === env ? { ...environment, name } : environment
            )
          })),
        { env: environmentId, name }
      )
    await renameHost(LONG_HOST_NAME)
    const longPlaceholder = minimaxChip(page).locator(
      `[title^="Not configured on ${LONG_HOST_NAME}"]`
    )
    await expect(longPlaceholder).toBeVisible()
    const hostName = longPlaceholder.locator('[data-owner-host]')
    await expect(hostName).toHaveText(LONG_HOST_NAME)
    const hostBox = await hostName.evaluate((node) => ({
      clientWidth: node.clientWidth,
      scrollWidth: node.scrollWidth
    }))
    expect(hostBox.clientWidth).toBeLessThanOrEqual(112)
    expect(hostBox.scrollWidth).toBeGreaterThan(hostBox.clientWidth)
    await shootStatusBar(page, '2b-server-owner-chip-long-host-truncated.png', outputPath)
    await renameHost(HOST_NAME)
    await expect(placeholder).toBeVisible()

    // A narrow bar drops chip labels; the placeholder keeps "--" so it never reads as healthy.
    await page.setViewportSize({ width: 360, height: 800 })
    await expect(placeholder).toHaveText('--', { timeout: 10_000 })
    await shootStatusBar(page, '2c-server-owner-compact-chip.png', outputPath)
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(placeholder).toHaveText(`Not configured on ${HOST_NAME}`)

    await page.getByRole('button', { name: 'Usage', exact: true }).click()
    const row = page.getByRole('menuitem').filter({ hasText: `Not configured on ${HOST_NAME}` })
    await expect(row).toBeVisible()
    await expect(row).toContainText('Its sign-in is saved on this computer only.')
    await page
      .getByRole('menu')
      .evaluate((menu) =>
        Promise.all(menu.getAnimations({ subtree: true }).map((animation) => animation.finished))
      )
    const menuBox = await page.getByRole('menu').boundingBox()
    if (!menuBox) {
      throw new Error('Usage popover has no box')
    }
    const viewport = page.viewportSize()
    if (!viewport) {
      throw new Error('Client page has no viewport')
    }
    // Why down to the bottom edge: keeps the status bar under the popover in frame.
    await page.screenshot({
      path: outputPathFor('3-server-owner-usage-popover.png', outputPath),
      clip: {
        x: Math.max(0, menuBox.x - 8),
        y: menuBox.y - 8,
        width: menuBox.width + 16,
        height: viewport.height - menuBox.y + 8
      }
    })

    await row.click()
    const hostPicker = page.getByRole('combobox', { name: 'Host' })
    await expect(hostPicker).toBeVisible({ timeout: 30_000 })
    await expect(hostPicker).toContainText(HOST_NAME)
    const pickerBox = await hostPicker.boundingBox()
    if (!pickerBox) {
      throw new Error('Host picker has no box')
    }
    await page.screenshot({
      path: outputPathFor('4-settings-opened-on-server-accounts.png', outputPath),
      clip: {
        x: Math.max(0, pickerBox.x - 320),
        y: Math.max(0, pickerBox.y - 80),
        width: 760,
        height: 360
      }
    })
  } finally {
    await client?.dispose()
  }
})

test('Claude set up only on this computer shows "No usage from <host>" under a server workspace', async ({
  sharedPage
}, testInfo) => {
  test.setTimeout(180_000)
  const outputPath = (name: string): string => testInfo.outputPath(name)
  // The host has no Claude login, so it reports Claude the way it reports API-key billing.
  // Why refresh: the host fetches usage on demand, not at launch.
  await sharedPage.evaluate(() => window.__store?.getState().refreshRateLimits())
  await sharedPage.waitForFunction(
    () => {
      const claude = window.__store?.getState().rateLimits.claude
      return (
        claude?.status === 'unavailable' &&
        claude.usageMetadata?.failureKind === 'missing-credentials'
      )
    },
    null,
    { timeout: 60_000 }
  )
  let client: PairedElectronClient | undefined
  try {
    client = await launchPairedElectronClient(
      await createRuntimeDesktopPairingOffer(sharedPage),
      testInfo,
      HOST_NAME,
      { extraEnv: { USER: NO_CLAUDE_LOGIN_USER } }
    )
    const { app, page, environmentId } = client
    await page.setViewportSize({ width: 1280, height: 800 })
    await expect(page.getByText('Workspace board moved to the bottom bar')).toHaveCount(0, {
      timeout: 20_000
    })

    // A refresh-token-only login counts as set up without any network call.
    const claudeConfigDir = path.join(
      await app.evaluate(({ app: electronApp }) => electronApp.getPath('home')),
      '.claude'
    )
    const setClaudeSetUpHere = async (setUp: boolean): Promise<void> => {
      if (setUp) {
        mkdirSync(claudeConfigDir, { recursive: true })
        writeFileSync(
          path.join(claudeConfigDir, '.credentials.json'),
          JSON.stringify({ claudeAiOauth: { refreshToken: 'e2e-fake-claude-refresh-token' } })
        )
      } else {
        rmSync(path.join(claudeConfigDir, '.credentials.json'), { force: true })
      }
      await page.evaluate(() => window.__store?.getState().refreshRateLimits())
      await page.waitForFunction(
        (expected) => (window.__store?.getState().rateLimits.claude?.status ?? null) === expected,
        setUp ? 'error' : 'unavailable',
        { timeout: 30_000 }
      )
    }
    await setClaudeSetUpHere(true)
    await focusFirstServerWorktree(page, environmentId)

    const claudeNote = `Claude usage isn't available from ${HOST_NAME}. It may not be signed in there, or it may use API-key billing.`
    const placeholder = page.locator('[data-usage-chip="claude"]').locator('[title]')
    await expect(placeholder).toBeVisible({ timeout: 60_000 })
    await expect(placeholder).toHaveText(`No usage from ${HOST_NAME}`)
    await expect(placeholder).toHaveAttribute('title', claudeNote)
    await expect(placeholder.locator('[data-owner-host]')).toHaveText(HOST_NAME)
    await shootStatusBar(page, '5-server-owner-claude-no-usage-chip.png', outputPath)

    await page.getByRole('button', { name: 'Usage', exact: true }).click()
    const row = page.getByRole('menuitem').filter({ hasText: `No usage from ${HOST_NAME}` })
    await expect(row).toBeVisible()
    await expect(row).toContainText(claudeNote)
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)

    // Without Claude here, the host's answer alone adds no Claude chip.
    await setClaudeSetUpHere(false)
    await expect(page.getByText(`No usage from ${HOST_NAME}`)).toHaveCount(0, { timeout: 30_000 })
  } finally {
    await client?.dispose()
  }
})
