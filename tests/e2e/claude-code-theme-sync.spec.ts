import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  discoverActivePtyId,
  execInTerminal,
  sendToTerminal,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

const enabled = process.env.ORCA_REAL_CLAUDE_THEME_TEST === '1'
// Claude Code's own light theme paints its prompt border this gray.
const CLAUDE_LIGHT_BORDER = 0x8a8a8a
const TOKYO_NIGHT_ACCENT = 0x7aa2f7
const GRUVBOX_DARK_ACCENT = 0x458588
const TOKYO_NIGHT_LIGHT_ACCENT = 0x34548a
// Covers Orca's first five reload attempts (to 120 s) when macOS drops file events.
const LIVE_SWITCH_TIMEOUT_MS = 130_000

// The config folder must exist before launch, so it is created at load, only when the test runs.
const root = enabled ? realpathSync(mkdtempSync(join(tmpdir(), 'orca-claude-theme-'))) : ''
const configDir = join(root, 'claude')
const workDir = join(root, 'work')
if (enabled) {
  mkdirSync(configDir)
  mkdirSync(workDir)
  writeFileSync(join(configDir, 'settings.json'), `${JSON.stringify({ theme: 'light' })}\n`)
  writeFileSync(
    join(configDir, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [workDir]: { hasTrustDialogAccepted: true } }
    })
  )
}
test.afterAll(() => {
  if (enabled) {
    rmSync(root, { recursive: true, force: true })
  }
})

test.use({
  launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraEnv: { CLAUDE_CONFIG_DIR: configDir, DISABLE_AUTOUPDATER: '1' }
})
test.skip(!enabled, 'Set ORCA_REAL_CLAUDE_THEME_TEST=1 to run the installed Claude Code')

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

async function startClaude(page: Page, ptyId: string): Promise<void> {
  await execInTerminal(page, ptyId, `cd '${workDir}' && clear && claude`)
  await waitForTerminalOutput(page, 'Claude Code', 30_000)
  await expect.poll(() => promptBorderColor(page), { timeout: 15_000 }).not.toBeNull()
}

async function exitClaude(page: Page, ptyId: string): Promise<void> {
  await sendToTerminal(page, ptyId, '/exit')
  await page.waitForTimeout(500)
  await sendToTerminal(page, ptyId, '\r')
  await waitForTerminalOutput(page, 'Resume this session', 15_000)
}

const readTheme = () =>
  JSON.parse(readFileSync(join(configDir, 'settings.json'), 'utf-8')).theme as unknown

test('Claude Code follows the Orca terminal theme live and restores its own theme', async ({
  orcaPage
}, testInfo) => {
  test.setTimeout(6 * 60_000)
  await waitForSessionReady(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const updateSettings = (updates: Record<string, unknown>) =>
    orcaPage.evaluate((next) => window.__store!.getState().updateSettings(next), updates)
  const shot = (name: string) =>
    orcaPage
      .locator('.pane:visible .xterm-screen')
      .first()
      .screenshot({ path: testInfo.outputPath(`${name}.png`) })
  await updateSettings({
    claudeCodeThemeSync: false,
    theme: 'dark',
    terminalThemeDark: 'Tokyo Night',
    terminalThemeLight: 'Tokyo Night Light',
    terminalUseSeparateLightTheme: true
  })
  // Orca takes the theme over at launch (the default); turning it off must have restored it.
  await expect.poll(readTheme, { timeout: 30_000 }).toBe('light')
  const ptyId = await discoverActivePtyId(orcaPage)

  // Off matches main: Claude keeps its own light theme on the dark terminal.
  await startClaude(orcaPage, ptyId)
  expect(await promptBorderColor(orcaPage)).toBe(CLAUDE_LIGHT_BORDER)
  await shot('before-dark')
  await exitClaude(orcaPage, ptyId)

  await updateSettings({ claudeCodeThemeSync: true })
  await expect.poll(readTheme, { timeout: 15_000 }).toBe('custom:orca')
  await startClaude(orcaPage, ptyId)
  expect(await promptBorderColor(orcaPage)).toBe(TOKYO_NIGHT_ACCENT)
  await shot('after-dark')

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
  await orcaPage.screenshot({ path: testInfo.outputPath('settings-toggle-on.png') })
  await toggle.click()
  await expect(toggle).not.toBeChecked()
  await expect.poll(readTheme, { timeout: 15_000 }).toBe('light')
  await orcaPage.evaluate(() => window.__store!.getState().closeSettingsPage())
  const restoreMs = await expectLiveSwitch(orcaPage, TOKYO_NIGHT_LIGHT_ACCENT, CLAUDE_LIGHT_BORDER)
  await shot('restored-light')
  testInfo.annotations.push({
    type: 'live-switch-ms',
    description: JSON.stringify({ darkSwitchMs, lightSwitchMs, restoreMs })
  })
  await exitClaude(orcaPage, ptyId)
})
