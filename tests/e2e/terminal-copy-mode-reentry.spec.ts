import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { pressShortcut } from './helpers/shortcuts'
import { waitForActiveTerminalManager } from './helpers/terminal'
import {
  configureCopyMode,
  expectCopyCursorReady,
  expectHiddenCopyModeWindow,
  seedCopyModeScreen,
  startCopyModeTerminalProbe
} from './helpers/terminal-copy-mode-fixture'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWrites
} from './helpers/terminal-pty-write-spy'

test.beforeEach(async ({ orcaPage, electronApp }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  await startCopyModeTerminalProbe(orcaPage)
  await seedCopyModeScreen(orcaPage)
  await installTerminalPtyWriteSpy(electronApp)
  await clearTerminalPtyWriteLog(electronApp)
})

for (const key of ['x', 'y']) {
  test(`fresh ${key === 'x' ? 'default' : 'remapped'} entry works after a missing shortcut keyup`, async ({
    orcaPage,
    electronApp
  }) => {
    await configureCopyMode(orcaPage, {
      keybindings: { 'terminal.enterCopyMode': [`Mod+Shift+${key.toUpperCase()}`] }
    })
    const isMac = await orcaPage.evaluate(() => navigator.userAgent.includes('Mac'))
    const cdp = await orcaPage.context().newCDPSession(orcaPage)
    const mode = orcaPage.getByRole('region', { name: 'Copy mode', exact: true })
    // macOS can omit the letter release while Command is held.
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: key.toUpperCase(),
      code: `Key${key.toUpperCase()}`,
      windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0),
      modifiers: 8 | (isMac ? 4 : 2),
      autoRepeat: false
    })
    await expectCopyCursorReady(orcaPage)
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: isMac ? 'Meta' : 'Control',
      code: isMac ? 'MetaLeft' : 'ControlLeft',
      windowsVirtualKeyCode: isMac ? 91 : 17,
      modifiers: 0
    })
    await orcaPage.keyboard.press('q')
    await expect(mode).toHaveCount(0)
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await pressShortcut(orcaPage, key, { shift: true })
      await expectCopyCursorReady(orcaPage)
      await orcaPage.keyboard.press('q')
      await expect(mode).toHaveCount(0)
    }
    expect(await readTerminalPtyWrites(electronApp)).toEqual([])
    await expectHiddenCopyModeWindow(electronApp)
    await cdp.detach()
  })
}

test('copy-mode observation is active only during a session and releases on pane removal', async ({
  orcaPage,
  electronApp
}) => {
  const tabId = await orcaPage.evaluate(() => {
    const observers = new Set<MutationObserver>()
    const NativeMutationObserver = window.MutationObserver
    window.MutationObserver = class extends NativeMutationObserver {
      observe(target: Node, options?: MutationObserverInit): void {
        super.observe(target, options)
        if (
          target instanceof HTMLElement &&
          target.hasAttribute('data-terminal-tab-id') &&
          options?.childList &&
          options.subtree &&
          options.attributeFilter?.includes('class') &&
          options.attributeFilter.includes('style')
        ) {
          observers.add(this)
        }
      }
      disconnect(): void {
        observers.delete(this)
        super.disconnect()
      }
    }
    Object.defineProperty(window, '__copyModeScopeObservers', { get: () => observers.size })
    const state = window.__store?.getState()
    if (!state?.activeWorktreeId) {
      throw new Error('No worktree for copy-mode observation')
    }
    return state.createTab(state.activeWorktreeId).id
  })
  await waitForActiveTerminalManager(orcaPage)
  await seedCopyModeScreen(orcaPage)
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  const observerCount = async () =>
    (
      await cdp.send('Runtime.evaluate', {
        expression: 'globalThis.__copyModeScopeObservers',
        returnByValue: true
      })
    ).result.value
  await expect.poll(observerCount).toBe(0)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await pressShortcut(orcaPage, 'x', { shift: true })
    await expectCopyCursorReady(orcaPage)
    await expect.poll(observerCount).toBe(1)
    await orcaPage.keyboard.press('q')
    await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
    await expect.poll(observerCount).toBe(0)
  }
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await expect.poll(observerCount).toBe(1)
  await orcaPage.evaluate((tabId) => {
    const pane = window.__paneManagers?.get(tabId)?.getActivePane()
    if (!pane) {
      throw new Error('No pane for copy-mode cleanup')
    }
    pane.container.remove()
  }, tabId)
  await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
  await expect.poll(observerCount).toBe(0)
  await expectHiddenCopyModeWindow(electronApp)
  await cdp.detach()
})

test('a fresh key does not release a different held exit key into the PTY', async ({
  orcaPage,
  electronApp
}) => {
  await pressShortcut(orcaPage, 'x', { shift: true })
  await expectCopyCursorReady(orcaPage)
  await orcaPage.keyboard.down('q')
  await expect(orcaPage.locator('.terminal-copy-mode')).toHaveCount(0)
  await orcaPage.keyboard.press('l')
  await orcaPage.keyboard.down('q')
  await orcaPage.keyboard.up('q')
  await expect.poll(async () => (await readTerminalPtyWrites(electronApp)).join('')).toBe('l')
  await orcaPage.keyboard.press('q')
  await expect.poll(async () => (await readTerminalPtyWrites(electronApp)).join('')).toBe('lq')
})
