import { test, expect } from './helpers/orca-app'
import {
  ensureTerminalVisible,
  waitForActiveWorktree,
  waitForSessionReady,
  waitForStartupWorktreeRefresh
} from './helpers/store'
import {
  readPaneIdentitySnapshot,
  splitActiveTerminalPane,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'

for (const route of [
  'number',
  'click',
  'previous-next',
  'same-type',
  'terminal-only',
  'recent'
] as const) {
  test(`restores the third connected terminal pane via ${route}`, async ({
    orcaPage,
    electronApp
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForStartupWorktreeRefresh(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await orcaPage.setViewportSize({ width: 1440, height: 900 })
    await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('Expected an active workspace')
      }
      for (let i = 0; i < 2; i++) {
        state.createTab(state.activeWorktreeId)
      }
    })
    const tabs = orcaPage.locator('[data-testid="sortable-tab"]')
    await expect(tabs).toHaveCount(3)
    await tabs.nth(1).click({ force: true })
    await tabs.nth(2).click({ force: true })
    await waitForActiveTerminalManager(orcaPage)
    await waitForPaneIdentitySnapshot(orcaPage, 1)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    await waitForPaneIdentitySnapshot(orcaPage, 2)
    await splitActiveTerminalPane(orcaPage, 'vertical')
    const snapshot = await waitForPaneIdentitySnapshot(orcaPage, 3)
    // Let initial tab activation finish before selecting a pane in the connected layout.
    await orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    const firstLeafId = snapshot.panes[0].leafId
    const lastLeafId = snapshot.panes[2].leafId
    // Establish a saved selection after all shells bind, independently of split startup.
    for (const leafId of [firstLeafId, lastLeafId]) {
      await orcaPage.locator(`.pane[data-leaf-id="${leafId}"] .xterm-screen`).click({ force: true })
    }
    await expect
      .poll(async () => (await readPaneIdentitySnapshot(orcaPage))?.storeActiveLeafId)
      .toBe(lastLeafId)
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => document.activeElement?.closest<HTMLElement>('.pane')?.dataset.leafId
        )
      )
      .toBe(lastLeafId)
    await testInfo.attach('01-third-pane-selected', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
    expect(
      await orcaPage.evaluate(
        () => document.activeElement?.closest<HTMLElement>('.pane')?.dataset.leafId
      )
    ).toBe(lastLeafId)

    const browserWindow = await electronApp.browserWindow(orcaPage)
    const navigate = async (returning: boolean) => {
      if (route === 'click') {
        await tabs.nth(returning ? 2 : 0).click({ force: true })
        return
      }
      // Electron input reaches the main-process shortcut policy without activating the OS window.
      await browserWindow.evaluate(
        (window, options) => {
          const mod = process.platform === 'darwin' ? 'meta' : 'control'
          const modifiers: ('control' | 'meta' | 'alt' | 'shift')[] =
            options.route === 'number'
              ? [process.platform === 'darwin' ? 'control' : 'alt']
              : options.route === 'terminal-only' || options.route === 'recent'
                ? ['control']
                : [mod, options.route === 'same-type' ? 'alt' : 'shift']
          const keyCode =
            options.route === 'number'
              ? options.returning
                ? '3'
                : '1'
              : options.route === 'recent'
                ? 'Tab'
                : options.route === 'terminal-only'
                  ? options.returning
                    ? 'PageDown'
                    : 'PageUp'
                  : options.returning
                    ? ']'
                    : '['
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
          if (options.route === 'recent') {
            window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Control' })
          }
        },
        { route, returning }
      )
    }
    await navigate(false)
    await expect(tabs.nth(route === 'click' || route === 'number' ? 0 : 1)).toHaveAttribute(
      'data-active',
      'true'
    )
    await testInfo.attach('02-other-terminal-tab', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
    await navigate(true)
    await expect(tabs.nth(2)).toHaveAttribute('data-active', 'true')
    await expect
      .poll(() =>
        orcaPage.evaluate(() => {
          const active = document.activeElement
          return active?.classList.contains('xterm-helper-textarea')
            ? active.closest('[data-terminal-tab-id]')?.getAttribute('data-terminal-tab-id')
            : null
        })
      )
      .toBe(snapshot.tabId)
    await orcaPage.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
        })
    )
    const marker = `TAB_RETURN_${Date.now()}`
    await orcaPage.keyboard.type(marker)
    const readPanes = () =>
      orcaPage.evaluate(
        (tabId) =>
          window.__paneManagers
            ?.get(tabId)
            ?.getPanes()
            .map((pane) => ({
              leafId: pane.leafId,
              content: pane.serializeAddon?.serialize?.() ?? ''
            })) ?? [],
        snapshot.tabId
      )
    await expect
      .poll(async () => (await readPanes()).some((pane) => pane.content.includes(marker)))
      .toBe(true)
    await testInfo.attach('03-input-after-tab-return', {
      body: await orcaPage.screenshot(),
      contentType: 'image/png'
    })
    expect(
      await orcaPage.evaluate(
        () => document.activeElement?.closest<HTMLElement>('.pane')?.dataset.leafId
      )
    ).toBe(lastLeafId)
    expect(
      (await readPanes()).filter((pane) => pane.content.includes(marker)).map((pane) => pane.leafId)
    ).toEqual([lastLeafId])
  })
}
