import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActiveTerminalManager, waitForPaneCount } from './helpers/terminal'

test('link underline preference repaints an existing OSC 8 link and preserves hover', async ({
  orcaPage
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await waitForPaneCount(orcaPage, 1)
  const sample =
    '\x1b[2J\x1b[H\x1b]8;;https://example.com\x1b\\OSC_LINK\x1b]8;;\x1b\\\r\n\x1b[4mEXPLICIT\x1b[0m'
  const target = await orcaPage.evaluate(async (output) => {
    const state = window.__store!.getState()
    await state.updateSettings({ terminalGpuAcceleration: 'off', terminalLinkUnderlines: 'hover' })
    const manager = window.__paneManagers!.get(
      state.activeTabIdByWorktree[state.activeWorktreeId!]!
    )!
    const pane = manager.getActivePane()!
    await new Promise<void>((resolve) => pane.terminal.write(output, resolve))
    const rect = pane.terminal.element!.querySelector('.xterm-screen')!.getBoundingClientRect()
    const cell = pane.terminal.dimensions!.css.cell
    return { x: rect.left + cell.width * 4, y: rect.top + cell.height * 0.5 }
  }, sample)
  const underlined = () =>
    orcaPage
      .locator('.xterm-rows > div')
      .filter({ hasText: 'OSC_LINK' })
      .locator('[class*="xterm-underline"], [style*="text-decoration: underline"]')
  await orcaPage.mouse.move(0, 0)
  await expect(underlined()).toHaveCount(0)
  await orcaPage.screenshot({ path: test.info().outputPath('hover-idle.png') })
  await orcaPage.mouse.move(target.x, target.y)
  await expect(underlined()).not.toHaveCount(0)
  await orcaPage.screenshot({ path: test.info().outputPath('hover-active.png') })
  await orcaPage.mouse.move(0, 0)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ terminalLinkUnderlines: 'always' })
  })
  await expect(underlined()).not.toHaveCount(0)
  await orcaPage.screenshot({ path: test.info().outputPath('always.png') })
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ terminalLinkUnderlines: 'hover' })
  })
  await expect(underlined()).toHaveCount(0)
  await expect(
    orcaPage
      .locator('.xterm-rows > div')
      .filter({ hasText: 'EXPLICIT' })
      .locator('[class*="xterm-underline"]')
  ).not.toHaveCount(0)
})
