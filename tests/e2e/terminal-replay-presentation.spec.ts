import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'
import type { TerminalReplayPresentationProbe } from './fixtures/terminal-replay-presentation-probe'

test.use({ orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: '120000' } })

for (const scenario of [
  { name: 'at a foreign grid in DOM', resize: true, gpu: 'off' },
  { name: 'at the same grid in DOM', resize: false, gpu: 'off' },
  { name: 'at a foreign grid in WebGL', resize: true, gpu: 'on' }
] as const) {
  test(`retains the painted frame ${scenario.name}`, async ({ orcaPage }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage)
    await focusActiveTerminalInput(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const quietProcess = await runNodeScriptInTerminal(
      orcaPage,
      ptyId,
      "process.stdout.write('REPLAY_PROBE_READY\\r\\n'); process.stdin.on('data', () => process.stdout.write('REVEAL_INPUT_ACK\\r\\n'))"
    )
    await expect.poll(() => getTerminalContent(orcaPage, 10_000)).toContain('REPLAY_PROBE_READY')
    quietProcess.cleanup()

    const bundle = await build({
      entryPoints: [
        path.join(process.cwd(), 'tests/e2e/fixtures/terminal-replay-presentation-probe.ts')
      ],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      alias: { '@': path.join(process.cwd(), 'src/renderer/src') },
      define: { 'import.meta.env': '{}' }
    })
    const script = bundle.outputFiles[0]?.text
    if (!script) {
      throw new Error('Replay presentation probe did not build')
    }
    await orcaPage.addScriptTag({ content: script })
    await orcaPage.evaluate(
      (gpu) => window.__terminalReplayPresentationProbe?.prepare(gpu),
      scenario.gpu
    )
    const screen = orcaPage.locator('[data-replay-paint-probe="true"]')
    const input = screen.locator('.xterm-helper-textarea')
    if (scenario.gpu === 'on') {
      const webglAttached = await screen
        .locator('canvas')
        .first()
        .waitFor({ state: 'attached', timeout: 10_000 })
        .then(() => true)
        .catch(() => false)
      // Why: headless Linux CI (xvfb, no GPU) falls back to the DOM renderer.
      test.skip(!webglAttached, 'WebGL renderer is unavailable in this environment')
    } else {
      await expect(screen.locator('.xterm-rows')).toBeVisible()
    }
    await expect(input).toBeFocused()
    // Why: feature-tip tooltips can overlap the screen clip and change between captures.
    await orcaPage.addStyleTag({
      content: '[role="tooltip"] { display: none !important; }'
    })
    const before = await screen.boundingBox()
    if (!before) {
      throw new Error('Terminal screen has no measurable viewport')
    }
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    const captureFrame = async (name: string): Promise<Buffer> => {
      const { data } = await cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { ...before, scale: 1 },
        captureBeyondViewport: false
      })
      const image = Buffer.from(data, 'base64')
      await writeFile(testInfo.outputPath(name), image)
      return image
    }
    const previous = await captureFrame('before-replay.png')

    try {
      // Hidden Electron screenshots can outlive the presentation hold cap, so freeze timers once the replay is held.
      await orcaPage.clock.install()
      await orcaPage.evaluate(
        (resize) => window.__terminalReplayPresentationProbe?.start(resize),
        scenario.resize
      )
      await orcaPage.waitForFunction(() => window.__terminalReplayPresentationProbe?.waiting)
      // Why a small lead: pauseAt cannot target a fake time that already passed.
      await orcaPage.clock.pauseAt(await orcaPage.evaluate(() => Date.now() + 50))
      const during = await captureFrame('during-replay.png')
      expect(
        compareTerminalScreenshots(previous, during).diffRatio,
        'replay must retain pixels, not flash blank'
      ).toBeLessThan(0.001)
      await expect(input).toBeFocused()
      await expect(input).toHaveCSS('visibility', 'visible')

      await orcaPage.clock.resume()
      await orcaPage.evaluate(async () => {
        const probe: TerminalReplayPresentationProbe | undefined =
          window.__terminalReplayPresentationProbe
        probe?.release()
        await probe?.completion
      })
      await expect(screen).toHaveCSS('opacity', '1')
      await expect(input).toBeFocused()
      await expect(orcaPage.locator('[data-terminal-replay-frame]')).toHaveCount(0)
      const after = await screen.boundingBox()
      expect(after?.width).toBeCloseTo(before.width, 0)
      expect(after?.height).toBeCloseTo(before.height, 0)
      const final = await captureFrame('after-replay.png')
      expect(compareTerminalScreenshots(previous, final).diffRatio).toBeGreaterThan(0.01)
    } finally {
      await testInfo.attach('replay-events', {
        body: JSON.stringify(
          await orcaPage.evaluate(() => window.__terminalReplayPresentationProbe?.trace),
          null,
          2
        ),
        contentType: 'application/json'
      })
      await orcaPage.evaluate(() => window.__terminalReplayPresentationProbe?.dispose())
      await orcaPage.clock.resume().catch(() => undefined)
      await cdp.detach()
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })
}
