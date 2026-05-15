import type { Page, TestInfo } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { waitForActivePanePtyId, waitForActiveTerminalManager } from './helpers/terminal'

// Why: regression coverage for the mobile-presence-lock UX (PR #1532,
// docs/mobile-presence-lock.md, docs/mobile-fit-hold.md). Two things matter:
//
//   1. When mobile subscribes, the desktop overlay MUST mount with a working
//      Take back affordance. The original bug was that the predecessor banner
//      mounted but was visually unobtrusive enough that users missed it
//      entirely. Strong DOM assertions guard against the "doesn't mount /
//      doesn't dismiss" regression class.
//
//   2. Reviewers should be able to eyeball the visual treatment on every PR
//      without pulling the branch. Screenshots are attached via
//      testInfo.attach so they ride along in the Playwright HTML report
//      that the e2e workflow uploads as a GHA artifact.
//
// The spec drives the runtime directly via electronApp.evaluate against the
// E2E-gated globalThis.__orcaRuntime exposure in src/main/index.ts (the same
// gate that already controls dynamic ws ports). That matches the same code
// path the mobile WebSocket RPC takes (terminal.subscribe →
// handleMobileSubscribe), without standing up a fake WS client per test.

test.describe.configure({ mode: 'serial' })

test('mobile subscribe mounts overlay; Take back dismisses it', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const ptyId = await waitForActivePanePtyId(orcaPage)

  // Baseline: clean terminal, no overlay.
  const overlay = orcaPage.locator('.mobile-driver-banner')
  await expect(overlay).toHaveCount(0)
  await captureAttachment(orcaPage, testInfo, '01-desktop-clean.png')

  // Simulate the iOS app subscribing in 'auto' mode with a phone-sized viewport.
  // This is exactly what terminal.subscribe does on the mobile WS RPC
  // (src/main/runtime/rpc/methods/terminal.ts) — it calls
  // runtime.handleMobileSubscribe(ptyId, clientId, viewport).
  await electronApp.evaluate(
    async (_app, args) => {
      // The augmented global is declared in src/main/index.ts so the cast is unnecessary.
      const runtime = globalThis.__orcaRuntime
      if (!runtime) {
        throw new Error('globalThis.__orcaRuntime missing — main/index.ts E2E gate not active')
      }
      await runtime.handleMobileSubscribe(args.ptyId, args.clientId, args.viewport)
    },
    { ptyId, clientId: 'fake-phone-1', viewport: { cols: 45, rows: 20 } }
  )

  // Overlay mounts via the runtime → notifier → renderer IPC chain. 15s budget
  // matches waitForActivePanePtyId — IPC round-trips can be slow on CI.
  await expect(overlay).toBeVisible({ timeout: 15_000 })
  await expect(overlay).toContainText(/mobile is driving this terminal/i)
  await expect(overlay).toContainText(/your keyboard is paused/i)

  const takeBack = overlay.getByRole('button', { name: /take back/i })
  await expect(takeBack).toBeVisible()

  await captureAttachment(orcaPage, testInfo, '02-mobile-driving.png')

  // Clicking Take back must dismiss the overlay (driver flips to 'desktop',
  // override clears, banner unmounts). Catches the "stuck overlay" regression.
  await takeBack.click()
  await expect(overlay).toBeHidden({ timeout: 15_000 })

  await captureAttachment(orcaPage, testInfo, '03-after-take-back.png')
})

// Why: writing the screenshot to testInfo.outputPath() puts the file inside
// the test's per-run output dir (the standard Playwright location uploaded as
// the playwright-artifacts GHA artifact in .github/workflows/e2e.yml). The
// `body` form of testInfo.attach didn't reliably persist the attachment to
// disk for the `list` reporter; round-tripping through outputPath does.
async function captureAttachment(page: Page, testInfo: TestInfo, fileName: string): Promise<void> {
  const dest = testInfo.outputPath(fileName)
  await page.screenshot({ path: dest, fullPage: true })
  await testInfo.attach(fileName, { path: dest, contentType: 'image/png' })
}
