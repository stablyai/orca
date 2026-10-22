/**
 * The focus-isolation scenarios in a visible window that owns OS focus (#20595). After the agent's
 * input, a real OS keystroke (xdotool) must reach the user's terminal, not the page.
 * Measured: webContents.getFocusedWebContents() reports the guest whenever a <webview> exists, so
 * only a real keystroke shows where the user's typing goes.
 * Visible-window spec: run it on an isolated display (CI's Xvfb lane), never on a desktop in use.
 */

import { execFileSync } from 'node:child_process'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import {
  evalInPage,
  readHost,
  runAgentClicksScenario,
  runAgentCrossSiteFrameScenario,
  runAgentKeysScenario,
  runAgentShortcutsScenario,
  type AfterAgentInput
} from './helpers/browser-agent-focus-scenarios'

function hasXdotool(): boolean {
  try {
    execFileSync('xdotool', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function realKeystrokeReachesTerminal(
  orcaPage: Page,
  electronApp: ElectronApplication
): AfterAgentInput {
  return async (pageId) => {
    expect(
      await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() !== null)
    ).toBe(true)
    const pageKeysBefore = await evalInPage(orcaPage, pageId, 'JSON.stringify(window.__keys)')
    execFileSync('xdotool', ['key', 'y'])
    await expect.poll(async () => (await readHost(orcaPage)).log.includes('key:y')).toBe(true)
    expect(await evalInPage(orcaPage, pageId, 'JSON.stringify(window.__keys)')).toBe(pageKeysBefore)
    expect((await readHost(orcaPage)).terminalFocused).toBe(true)
  }
}

const scenarios = [
  ['agent keys and text', runAgentKeysScenario],
  ['agent clicks and presses', runAgentClicksScenario],
  ['agent shortcut keys', runAgentShortcutsScenario],
  ['agent keys in a cross-site frame', runAgentCrossSiteFrameScenario]
] as const

for (const [name, run] of scenarios) {
  test(`${name} leave the user’s real keystrokes in the terminal @headful`, async ({
    orcaPage,
    electronApp
  }) => {
    test.skip(process.platform !== 'linux', 'real keystrokes come from xdotool on the Xvfb lane')
    expect(hasXdotool(), 'install xdotool on the Xvfb lane').toBe(true)
    test.setTimeout(120_000)
    await orcaPage.bringToFront()
    await run(orcaPage, realKeystrokeReachesTerminal(orcaPage, electronApp))
  })
}
