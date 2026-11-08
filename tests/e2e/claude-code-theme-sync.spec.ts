import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  discoverActivePtyId,
  execInTerminal,
  sendToTerminal,
  waitForActiveTerminalManager
} from './helpers/terminal'

const enabled = process.env.ORCA_REAL_CLAUDE_THEME_TEST === '1'
// Claude Code's own light theme paints its prompt border this gray.
const CLAUDE_LIGHT_BORDER = 0x8a8a8a
const TOKYO_NIGHT_ACCENT = 0x7aa2f7
const GRUVBOX_DARK_ACCENT = 0x458588
const TOKYO_NIGHT_LIGHT_ACCENT = 0x34548a
// Covers Orca's first five reload attempts (to 120 s) when macOS drops file events.
const LIVE_SWITCH_TIMEOUT_MS = 130_000

test.use({
  launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraEnv: { DISABLE_AUTOUPDATER: '1' }
})
test.skip(!enabled, 'Set ORCA_REAL_CLAUDE_THEME_TEST=1 to run the installed Claude Code')
// The journey types POSIX shell commands.
test.skip(process.platform === 'win32', 'Uses a POSIX shell command line')

/** Claude's prompt border: the first cell of the first full-width rule it draws. */
function promptBorderColor(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const pane = window.__paneManagers?.get(state.activeTabId ?? '')?.getActivePane()
    const buffer = pane?.terminal.buffer.active
    if (!buffer) {
      return null
    }
    for (let y = buffer.length - 1; y >= 0; y -= 1) {
      const line = buffer.getLine(y)
      if (line?.translateToString(true).startsWith('────────')) {
        const cell = line.getCell(0)
        return cell?.isFgRGB() ? cell.getFgColor() : null
      }
    }
    return null
  })
}

/** Samples the border until it shows `target`; every earlier sample must still show `previous`
 *  (a redraw can briefly hide the border, so samples without one are skipped). */
async function expectLiveSwitch(page: Page, previous: number, target: number): Promise<number> {
  const started = Date.now()
  const frames: number[] = []
  await expect
    .poll(
      async () => {
        const color = await promptBorderColor(page)
        if (color !== null) {
          frames.push(color)
        }
        return color
      },
      { timeout: LIVE_SWITCH_TIMEOUT_MS, intervals: [100] }
    )
    .toBe(target)
  expect(frames.slice(0, -1).every((color) => color === previous)).toBe(true)
  return Date.now() - started
}

/** Plain text of the active pane; Claude styles words separately, so serialized output splits them. */
function terminalText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const state = window.__store!.getState()
    const buffer = window.__paneManagers?.get(state.activeTabId ?? '')?.getActivePane()?.terminal
      .buffer.active
    const lines: string[] = []
    for (let y = 0; buffer && y < buffer.length; y += 1) {
      lines.push(buffer.getLine(y)?.translateToString(true) ?? '')
    }
    return lines.join('\n')
  })
}

async function startClaude(page: Page, ptyId: string, workDir: string): Promise<void> {
  await execInTerminal(page, ptyId, `cd '${workDir}' && clear && claude`)
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain('Claude Code v')
  await expect.poll(() => promptBorderColor(page), { timeout: 15_000 }).not.toBeNull()
}

async function exitClaude(page: Page, ptyId: string): Promise<void> {
  await sendToTerminal(page, ptyId, '/exit')
  // Enter must land after the command menu picked /exit, or Claude submits a prompt.
  await expect.poll(() => terminalText(page), { timeout: 10_000 }).toContain('Exit the CLI')
  await sendToTerminal(page, ptyId, '\r')
  // Back at the shell prompt.
  await expect
    .poll(async () => (await terminalText(page)).trimEnd().split('\n').at(-1)?.trimEnd(), {
      timeout: 15_000
    })
    .toMatch(/[$%#]$/)
}

type Journey = {
  home: string
  workDir: string
  ptyId: string
  readTheme: () => unknown
  readThemeFile: () => string
  updateSettings: (updates: Record<string, unknown>) => Promise<unknown>
  shot: (name: string) => Promise<unknown>
  windowShot: (name: string) => Promise<unknown>
}

/** An existing profile (the e2e fixture seeds one) whose Claude Code uses its own light theme. */
async function startJourney(
  electronApp: ElectronApplication,
  orcaPage: Page,
  testInfo: { outputPath: (name: string) => string },
  appTheme: 'dark' | 'light'
): Promise<Journey> {
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const updateSettings = (updates: Record<string, unknown>) =>
    orcaPage.evaluate((next) => window.__store!.getState().updateSettings(next), updates)
  const settings = () =>
    orcaPage.evaluate(() => {
      const { claudeCodeThemeSync, claudeCodeThemeSyncOffer } = window.__store!.getState().settings!
      return { claudeCodeThemeSync, claudeCodeThemeSyncOffer }
    })
  // Existing profiles start with the sync off and an offer owed.
  expect(await settings()).toEqual({
    claudeCodeThemeSync: false,
    claudeCodeThemeSyncOffer: 'pending'
  })
  await updateSettings({
    theme: appTheme,
    terminalThemeDark: 'Tokyo Night',
    terminalThemeLight: 'Tokyo Night Light',
    terminalUseSeparateLightTheme: true
  })
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const settingsPath = join(home, '.claude', 'settings.json')
  const workDir = join(home, 'claude-theme-work')
  mkdirSync(workDir, { recursive: true })
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(
    join(home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [workDir]: { hasTrustDialogAccepted: true } }
    })
  )
  const readSettings = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(settingsPath, 'utf-8'))
    } catch {
      return {}
    }
  }
  writeFileSync(settingsPath, `${JSON.stringify({ ...readSettings(), theme: 'light' }, null, 2)}\n`)
  const readThemeFile = () => {
    try {
      return readFileSync(join(home, '.claude', 'themes', 'orca.json'), 'utf-8')
    } catch {
      return ''
    }
  }
  return {
    home,
    workDir,
    ptyId: await discoverActivePtyId(orcaPage),
    readTheme: () => readSettings().theme,
    readThemeFile,
    updateSettings,
    shot: (name) =>
      orcaPage
        .locator('.pane:visible .xterm-screen')
        .first()
        .screenshot({ path: testInfo.outputPath(`${name}.png`) }),
    windowShot: (name) => orcaPage.screenshot({ path: testInfo.outputPath(`${name}.png`) })
  }
}

const offerTitle = 'Match Claude Code to your Orca theme?'

test('an existing user accepts the offer, then Claude Code follows the Orca theme live and restores', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  // Real Claude Code launches, three live switches and a restore, each allowed Orca's reload retries.
  test.setTimeout(6 * 60_000)
  const journey = await startJourney(electronApp, orcaPage, testInfo, 'dark')
  const { ptyId, workDir, readTheme, readThemeFile, updateSettings, shot, windowShot } = journey

  // Off matches main: Claude keeps its own light theme on the dark terminal, and Orca offers the sync once.
  await startClaude(orcaPage, ptyId, workDir)
  await expect
    .poll(() => promptBorderColor(orcaPage), { timeout: 15_000 })
    .toBe(CLAUDE_LIGHT_BORDER)
  await shot('before-dark')
  const offer = orcaPage.locator('[data-sonner-toast]').filter({ hasText: offerTitle })
  // Agent detection for a typed `claude` can lag its first frame.
  await expect(offer).toBeVisible({ timeout: 30_000 })
  // Shoot once the slide-in settled, so the proof shows the toast as users see it.
  await expect(offer).toHaveAttribute('data-mounted', 'true')
  await expect(offer).toBeInViewport({ ratio: 1 })
  await expect(offer).toHaveCSS('opacity', '1')
  await windowShot('offer-toast-dark')
  await offer.screenshot({ path: testInfo.outputPath('offer-toast-dark-closeup.png') })
  await offer.getByRole('button', { name: 'Match Theme' }).click()
  await expect.poll(readTheme, { timeout: 30_000 }).toBe('custom:orca')
  await expect.poll(readThemeFile, { timeout: 30_000 }).toContain('"promptBorder": "#7aa2f7"')
  await exitClaude(orcaPage, ptyId)

  // The previous session's frames stay in scrollback; wait for the new session's border.
  await startClaude(orcaPage, ptyId, workDir)
  await expect.poll(() => promptBorderColor(orcaPage), { timeout: 15_000 }).toBe(TOKYO_NIGHT_ACCENT)
  await shot('after-dark')
  await expect(orcaPage.locator('[data-sonner-toast]').filter({ hasText: offerTitle })).toHaveCount(
    0
  )

  // The running session recolors without a restart.
  await updateSettings({ terminalThemeDark: 'Gruvbox Dark' })
  const darkSwitchMs = await expectLiveSwitch(orcaPage, TOKYO_NIGHT_ACCENT, GRUVBOX_DARK_ACCENT)
  await shot('after-dark-live-gruvbox')
  await updateSettings({ theme: 'light' })
  const lightSwitchMs = await expectLiveSwitch(
    orcaPage,
    GRUVBOX_DARK_ACCENT,
    TOKYO_NIGHT_LIGHT_ACCENT
  )
  await shot('after-light-live')

  // Turning it off through the real switch restores the user's theme, live too.
  await orcaPage.evaluate(() => window.__store!.getState().openSettingsPage())
  await orcaPage.getByPlaceholder('Search settings').fill('Match Claude Code')
  const toggle = orcaPage.getByRole('switch', { name: 'Match Claude Code to Terminal Theme' })
  await expect(toggle).toBeChecked()
  await windowShot('settings-on-light')
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await windowShot('settings-off-light')
  await expect.poll(readTheme, { timeout: 15_000 }).toBe('light')
  await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
  const restoreMs = await expectLiveSwitch(orcaPage, TOKYO_NIGHT_LIGHT_ACCENT, CLAUDE_LIGHT_BORDER)
  await shot('restored-light')

  // The same switch in dark mode, off then on.
  await updateSettings({ theme: 'dark' })
  await orcaPage.evaluate(() => window.__store!.getState().openSettingsPage())
  await orcaPage.getByPlaceholder('Search settings').fill('Match Claude Code')
  await expect(toggle).not.toBeChecked()
  await windowShot('settings-off-dark')
  await toggle.click()
  await expect(toggle).toBeChecked()
  await expect.poll(readTheme, { timeout: 15_000 }).toBe('custom:orca')
  await windowShot('settings-on-dark')
  await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
  testInfo.annotations.push({
    type: 'live-switch-ms',
    description: JSON.stringify({ darkSwitchMs, lightSwitchMs, restoreMs })
  })
  await exitClaude(orcaPage, ptyId)
})

test('an existing user who declines the offer keeps Claude Code as it was and is not asked again', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  // Two real Claude Code launches.
  test.setTimeout(3 * 60_000)
  const { ptyId, workDir, readTheme, shot, windowShot } = await startJourney(
    electronApp,
    orcaPage,
    testInfo,
    'light'
  )
  await startClaude(orcaPage, ptyId, workDir)
  const offer = orcaPage.locator('[data-sonner-toast]').filter({ hasText: offerTitle })
  // Agent detection for a typed `claude` can lag its first frame.
  await expect(offer).toBeVisible({ timeout: 30_000 })
  // Shoot once the slide-in settled, so the proof shows the toast as users see it.
  await expect(offer).toHaveAttribute('data-mounted', 'true')
  await expect(offer).toBeInViewport({ ratio: 1 })
  await expect(offer).toHaveCSS('opacity', '1')
  await windowShot('offer-toast-light')
  await offer.screenshot({ path: testInfo.outputPath('offer-toast-light-closeup.png') })
  await offer.getByRole('button', { name: 'No Thanks' }).click()
  await expect(offer).toHaveCount(0)
  await expect
    .poll(() =>
      orcaPage.evaluate(() => window.__store!.getState().settings!.claudeCodeThemeSyncOffer)
    )
    .toBe('settled')
  await exitClaude(orcaPage, ptyId)
  await startClaude(orcaPage, ptyId, workDir)
  await expect
    .poll(() => promptBorderColor(orcaPage), { timeout: 15_000 })
    .toBe(CLAUDE_LIGHT_BORDER)
  await shot('declined-light')
  expect(readTheme()).toBe('light')
  await expect(offer).toHaveCount(0)
  await exitClaude(orcaPage, ptyId)
})
