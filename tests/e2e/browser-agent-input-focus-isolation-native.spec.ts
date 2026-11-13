// Prove browser-agent input preserves the user’s OS keyboard focus with a real keystroke (#20595).
// Run only on an isolated visible-window display; guest focus APIs alone cannot establish keyboard routing.

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
import { startWindowsForegroundHolder } from './helpers/windows-foreground-holder'

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
  electronApp: ElectronApplication,
  pressRealKey: (key: string) => Promise<void>
): AfterAgentInput {
  return async (pageId) => {
    await expect
      .poll(() =>
        electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow() !== null)
      )
      .toBe(true)
    const pageKeysBefore = await evalInPage(orcaPage, pageId, 'JSON.stringify(window.__keys)')
    await pressRealKey('y')
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
    await run(
      orcaPage,
      realKeystrokeReachesTerminal(orcaPage, electronApp, async (key) => {
        execFileSync('xdotool', ['key', key])
      })
    )
  })

  test(`${name} leave Orca behind the user’s app on Windows @headful`, async ({
    orcaPage,
    electronApp
  }) => {
    // Why: the holder takes the real foreground and the test presses real keys, so never on a desktop.
    test.skip(
      process.platform !== 'win32' || process.env.CI !== 'true',
      'real foreground and keystrokes need the Windows CI desktop'
    )
    test.setTimeout(120_000)
    const holder = await startWindowsForegroundHolder()
    try {
      await holder.take()
      await run(orcaPage, async (pageId) => {
        // Why: a guest press that activates Orca's window pulls it over the app the user is in.
        expect(await holder.foreground(), `Orca is pid ${electronApp.process().pid}`).toEqual({
          holder: true,
          pid: expect.any(Number)
        })
        await (await electronApp.browserWindow(orcaPage)).evaluate((window) => window.focus())
        await realKeystrokeReachesTerminal(orcaPage, electronApp, holder.press)(pageId)
      })
    } finally {
      await holder.close()
    }
  })
}
