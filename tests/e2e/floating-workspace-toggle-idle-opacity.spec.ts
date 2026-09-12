import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { execInTerminal, waitForActivePanePtyId, waitForTerminalOutput } from './helpers/terminal'

// Why: the context-menu wrapper carries the same data attribute, so scope to the
// button that actually owns the fade.
const TOGGLE_SELECTOR = 'button[data-floating-terminal-toggle]'

// Why: the parked launcher covers the bottom-right of the session area, which is
// where terminal output lands. Flood the viewport so every row the button
// overlaps actually carries text — otherwise the screenshots prove nothing.
const FLOOD_COMMAND =
  "node -e \"for (let i = 0; i < 60; i++) console.log('orca'.repeat(80)); console.log('FLOOD-DONE')\""

test.describe('floating workspace toggle idle opacity', () => {
  test('fades while parked and returns to full strength on hover', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)

    await orcaPage.evaluate(() => {
      const store = window.__store
      const state = store?.getState()
      if (!store || !state?.settings) {
        throw new Error('Store unavailable')
      }
      store.setState({
        // Why: with the right sidebar open the launcher parks over sidebar
        // chrome, not terminal output — the reported overlap only happens when
        // the terminal owns the full width.
        rightSidebarOpen: false,
        settings: {
          ...state.settings,
          floatingTerminalEnabled: true,
          floatingTerminalTriggerLocation: 'floating-button',
          // Why: dark is the surface where the launcher's own fill is closest to
          // the terminal background, so it is the strictest read of the fade.
          theme: 'dark'
        }
      })
    })

    const ptyId = await waitForActivePanePtyId(orcaPage)
    await execInTerminal(orcaPage, ptyId, FLOOD_COMMAND)
    await waitForTerminalOutput(orcaPage, 'FLOOD-DONE')

    const toggle = orcaPage.locator(TOGGLE_SELECTOR)
    await expect(toggle).toBeVisible()

    // Why: the fade is a CSS transition, so read the settled computed value
    // rather than the class list — this is what actually catches a Tailwind
    // scale miss where `opacity-45` never gets generated.
    const readOpacity = async (): Promise<number> =>
      Number(await toggle.evaluate((node) => getComputedStyle(node).opacity))

    await expect.poll(readOpacity, { message: 'idle toggle never faded' }).toBeCloseTo(0.45, 2)

    const box = await toggle.boundingBox()
    if (!box) {
      throw new Error('Toggle has no bounding box')
    }
    const clip = {
      x: Math.max(0, box.x - 320),
      y: Math.max(0, box.y - 24),
      width: 320 + box.width + 24,
      height: box.height + 48
    }
    const captureShot = async (name: string): Promise<void> => {
      const shotPath = testInfo.outputPath(name)
      await orcaPage.screenshot({ clip, path: shotPath })
      await testInfo.attach(name, { path: shotPath, contentType: 'image/png' })
    }
    // Why: the terminal repaints on animation frames that a headless window
    // throttles until it sees input. Park the pointer well clear of the launcher
    // so the flood is actually on screen while the button is still idle.
    await orcaPage.mouse.move(clip.x + 8, clip.y + 8)
    await orcaPage.waitForTimeout(500)
    await captureShot('idle-faded.png')

    await toggle.hover()
    await expect.poll(readOpacity, { message: 'hover never restored the toggle' }).toBe(1)
    await captureShot('hover-restored.png')

    // Why: an open panel owns the same control as "minimize"; it must never sit
    // at reduced strength over its own chrome.
    await toggle.click()
    await expect(orcaPage.locator('[data-floating-terminal-panel]')).toBeVisible()
    await orcaPage.mouse.move(10, 10)
    await expect.poll(readOpacity, { message: 'open panel left the toggle faded' }).toBe(1)
  })
})
