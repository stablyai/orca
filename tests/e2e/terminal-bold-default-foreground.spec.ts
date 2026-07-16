import { readFileSync } from 'node:fs'
import path from 'node:path'
import { PNG } from 'pngjs'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { nodeTerminalCommand } from './terminal-node-command'
import {
  sendToTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'

function countPixels(
  buffer: Buffer,
  matcher: (red: number, green: number, blue: number, alpha: number) => boolean
): number {
  const image = PNG.sync.read(buffer)
  let count = 0
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4
      if (
        matcher(
          image.data[offset] ?? 0,
          image.data[offset + 1] ?? 0,
          image.data[offset + 2] ?? 0,
          image.data[offset + 3] ?? 0
        )
      ) {
        count += 1
      }
    }
  }
  return count
}

function isNormalForeground(red: number, green: number, blue: number, alpha: number): boolean {
  return (
    alpha > 180 &&
    red > 180 &&
    green > 180 &&
    blue > 180 &&
    Math.abs(red - green) <= 28 &&
    Math.abs(red - blue) <= 28 &&
    Math.abs(green - blue) <= 28
  )
}

function isBoldOverrideMagenta(red: number, green: number, blue: number, alpha: number): boolean {
  return alpha > 180 && red > 180 && green < 20 && blue > 120
}

function isBoldOverrideCyan(red: number, green: number, blue: number, alpha: number): boolean {
  return alpha > 180 && red < 20 && green > 120 && blue > 70 && blue < 110
}

function isExplicitAnsiRed(red: number, green: number, blue: number, alpha: number): boolean {
  return alpha > 180 && red > 180 && green < 80 && blue < 80
}

async function configureRenderer(page: Page, mode: 'dom' | 'webgl'): Promise<void> {
  await page.evaluate((renderer) => {
    const state = window.__store?.getState()
    const manager = state?.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
    manager?.setTerminalGpuAcceleration?.(renderer === 'webgl' ? 'on' : 'off')
  }, mode)
  await expect
    .poll(
      () =>
        page.evaluate((renderer) => {
          const state = window.__store?.getState()
          const manager = state?.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
          return (
            manager
              ?.getRenderingDiagnostics?.()
              .some((entry) => entry.hasWebgl === (renderer === 'webgl')) ?? false
          )
        }, mode),
      { timeout: 10_000 }
    )
    .toBe(true)
}

async function setBoldOverride(page: Page, bold: string | undefined): Promise<void> {
  await page.evaluate(async (boldColor) => {
    const store = window.__store
    const state = store?.getState()
    if (!store || !state) {
      throw new Error('Store unavailable')
    }
    const terminalColorOverrides = { ...state.settings.terminalColorOverrides }
    if (boldColor) {
      terminalColorOverrides.bold = boldColor
    } else {
      delete terminalColorOverrides.bold
    }
    await state.updateSettings({
      terminalColorOverrides:
        Object.keys(terminalColorOverrides).length > 0 ? terminalColorOverrides : undefined
    })
  }, bold)

  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const state = window.__store?.getState()
          const manager = state?.activeTabId ? window.__paneManagers?.get(state.activeTabId) : null
          const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
          return {
            setting: state?.settings.terminalColorOverrides?.bold,
            theme: pane?.terminal.options.theme.bold
          }
        }, bold),
      { timeout: 10_000 }
    )
    .toEqual({ setting: bold, theme: bold })
}

test.describe('Bold Text default foreground', () => {
  test('honors the override in DOM and WebGL while preserving explicit colors', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const reproPath = process.env.ORCA_BOLD_REPRO_PATH
    const fixturePath = path.resolve(
      process.cwd(),
      'tests/e2e/fixtures/terminal-bold-default-foreground.txt'
    )
    const repro = readFileSync(reproPath ?? fixturePath)
    const fixture = readFileSync(fixturePath)
    expect(repro.equals(fixture), 'reproduction artifact must match the committed fixture').toBe(
      true
    )

    const ptyId = await waitForActivePanePtyId(orcaPage)
    const renderScript = `process.stdout.write(${JSON.stringify(
      '\u001b[2J\u001b[H\u001b[?25l\u001b[1mBOLD DEFAULT FG\u001b[0m\n\u001b[1;31mEXPLICIT BOLD FG\u001b[0m\nNON-BOLD DEFAULT FG\n'
    )})`
    await sendToTerminal(orcaPage, ptyId, `${nodeTerminalCommand(['-e', renderScript])}\r`)
    await waitForTerminalOutput(orcaPage, 'NON-BOLD DEFAULT FG')

    for (const mode of ['dom', 'webgl'] as const) {
      await configureRenderer(orcaPage, mode)
      for (const [state, color, matcher] of [
        ['add', '#ff00aa', isBoldOverrideMagenta],
        ['change', '#00ffaa', isBoldOverrideCyan],
        ['remove', undefined, isNormalForeground]
      ] as const) {
        await setBoldOverride(orcaPage, color)
        await orcaPage.waitForTimeout(250)
        const screenshotPath = process.env.ORCA_BOLD_SCREENSHOT_PATH
          ? `${process.env.ORCA_BOLD_SCREENSHOT_PATH}-${mode}-${state}.png`
          : testInfo.outputPath(`terminal-bold-default-foreground-${mode}-${state}.png`)
        const screenshot = await orcaPage.locator('.xterm-screen').first().screenshot({
          path: screenshotPath
        })
        expect(
          countPixels(screenshot, matcher),
          `${mode} ${state} screenshot should contain the expected bold-default color`
        ).toBeGreaterThan(0)
        expect(
          countPixels(screenshot, isNormalForeground),
          `${mode} ${state} screenshot should still contain normal foreground text`
        ).toBeGreaterThan(0)
        expect(
          countPixels(screenshot, isExplicitAnsiRed),
          `${mode} ${state} screenshot should keep the explicit ANSI red row`
        ).toBeGreaterThan(0)
      }
    }
  })
})
