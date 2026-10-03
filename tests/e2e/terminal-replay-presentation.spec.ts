import path from 'node:path'
import { writeFile } from 'node:fs/promises'
import { build } from 'esbuild'
import { expect, test } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  getActiveWorktreeId,
  getAllWorktreeIds,
  switchToWorktree,
  waitForSessionReady
} from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActivePaneHookDescriptor,
  waitForActiveTerminalManager
} from './helpers/terminal'
import { runNodeScriptInTerminal } from './helpers/run-node-script-in-terminal'
import { compareTerminalScreenshots } from './terminal-screenshot-diff'
import type { TerminalReplayPresentationProbe } from './fixtures/terminal-replay-presentation-probe'

test.use({ orcaAppExtraEnv: { ORCA_E2E_TERMINAL_PARKING_DELAY_MS: '120000' } })

for (const scenario of [
  { name: 'at a foreign grid in DOM', resize: true, gpu: 'off', workspace: false },
  { name: 'at the same grid in DOM', resize: false, gpu: 'off', workspace: false },
  { name: 'at a foreign grid in WebGL', resize: true, gpu: 'on', workspace: false },
  {
    name: 'after a workspace switch and delayed snapshot in DOM',
    resize: true,
    gpu: 'off',
    workspace: true
  },
  {
    name: 'after a workspace switch interrupted by input in DOM',
    resize: true,
    gpu: 'off',
    workspace: true,
    interrupt: true
  },
  {
    name: 'after a workspace switch and delayed snapshot in WebGL',
    resize: true,
    gpu: 'on',
    workspace: true
  }
] as const) {
  test(`retains the painted frame ${scenario.name}${scenario.gpu === 'on' ? ' @headful' : ''}`, async ({
    orcaPage
  }, testInfo) => {
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
    await (scenario.gpu === 'on'
      ? expect.poll(() => screen.locator('canvas').count()).toBeGreaterThan(0)
      : expect(screen.locator('.xterm-rows')).toBeVisible())
    const before = await screen.boundingBox()
    if (!before) {
      throw new Error('Terminal screen has no measurable viewport')
    }
    await expect(input).toBeFocused()
    const movedHint = orcaPage.getByRole('tooltip').filter({ hasText: 'moved to the bottom bar' })
    if (await movedHint.isVisible()) {
      const board = orcaPage.getByRole('button', { name: 'Workspace board', exact: true })
      await board.click()
      await board.click()
      await input.focus()
    }
    await orcaPage.mouse.move(2, 2)
    await expect(orcaPage.getByRole('tooltip')).toHaveCount(0)
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
    let previous = await orcaPage.screenshot({
      clip: before,
      path: testInfo.outputPath('before-replay.png')
    })
    const destinationPrevious = previous

    try {
      if (scenario.workspace) {
        const original = await getActiveWorktreeId(orcaPage)
        const other = (await getAllWorktreeIds(orcaPage)).find((id) => id !== original)
        if (!original || !other) {
          throw new Error('Workspace restore needs two worktrees')
        }
        const { paneKey } = await waitForActivePaneHookDescriptor(orcaPage)
        await switchToWorktree(orcaPage, other)
        await waitForActiveTerminalManager(orcaPage)
        await orcaPage.evaluate(() => {
          const tabId = window.__store?.getState().activeTabId
          const terminal = tabId
            ? window.__paneManagers?.get(tabId)?.getActivePane()?.terminal
            : null
          if (terminal) {
            terminal.options.cursorBlink = false
            terminal.write('\x1b[?25l')
          }
        })
        previous = await orcaPage.screenshot({
          clip: before,
          path: testInfo.outputPath('outgoing-workspace.png')
        })
        // Hidden Electron screenshots can outlive the real-time reveal budget.
        await orcaPage.clock.install()
        await orcaPage.clock.pauseAt(new Date())
        await orcaPage.evaluate(
          ({ ptyId, paneKey }) => {
            window.__terminalReplayPresentationProbe?.armRestore(ptyId, paneKey)
          },
          { ptyId, paneKey }
        )
        await switchToWorktree(orcaPage, original)
        await orcaPage.clock.runFor(16)
        const awaitingSnapshot = await captureFrame('awaiting-snapshot.png')
        expect(
          compareTerminalScreenshots(previous, awaitingSnapshot).diffRatio,
          'keep the outgoing workspace instead of previewing stale destination content'
        ).toBeLessThan(0.001)
        if ('interrupt' in scenario) {
          await expect(input).toBeFocused()
          await orcaPage.keyboard.type('echo REVEAL_INPUT_PROBE')
          await orcaPage.keyboard.press('Enter')
          await expect(orcaPage.locator('[data-terminal-reveal-held="true"]')).toHaveCount(0)
          previous = destinationPrevious
        }
        await orcaPage.evaluate(() => window.__terminalReplayPresentationProbe?.resolveRestore())
        await orcaPage.clock.runFor(64)
      } else {
        await orcaPage.evaluate(
          (resize) => window.__terminalReplayPresentationProbe?.start(resize),
          scenario.resize
        )
      }
      await orcaPage.waitForFunction(() => window.__terminalReplayPresentationProbe?.waiting)
      const during = await captureFrame('during-replay.png')
      expect(
        compareTerminalScreenshots(previous, during).diffRatio,
        'replay must retain pixels, not flash blank'
      ).toBeLessThan(0.001)
      await expect(input).toBeFocused()
      await expect(input).toHaveCSS('visibility', 'visible')

      await orcaPage.evaluate(async () => {
        const probe: TerminalReplayPresentationProbe | undefined =
          window.__terminalReplayPresentationProbe
        probe?.release()
        await probe?.completion
      })
      if (scenario.workspace) {
        await orcaPage.clock.runFor(64)
      }
      await expect(screen).toHaveCSS('opacity', '1')
      await expect(orcaPage.locator('[data-terminal-reveal-held="true"]')).toHaveCount(0)
      await expect(input).toBeFocused()
      await expect(orcaPage.locator('[data-terminal-replay-frame]')).toHaveCount(0)
      const after = await screen.boundingBox()
      expect(after?.width).toBeCloseTo(before.width, 0)
      expect(after?.height).toBeCloseTo(before.height, 0)
      const final = await captureFrame('after-replay.png')
      expect(compareTerminalScreenshots(previous, final).diffRatio).toBeGreaterThan(0.01)
      if ('interrupt' in scenario) {
        await orcaPage.clock.resume()
        await expect.poll(() => getTerminalContent(orcaPage, 10_000)).toContain('REVEAL_INPUT_ACK')
      }
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
      if (scenario.workspace) {
        await orcaPage.clock.resume()
      }
      await cdp.detach()
      await sendToTerminal(orcaPage, ptyId, '\x03').catch(() => undefined)
    }
  })
}
