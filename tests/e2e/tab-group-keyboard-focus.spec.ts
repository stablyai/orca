import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  createTerminalBrowserSplit,
  waitForBrowserGuestRegistration,
  shortcutModifier
} from './helpers/browser-split-fixture'
import { startBrowserSplitPageServer } from './helpers/browser-split-page-server'
import { waitForGuestUrl } from './helpers/browser-split-guest-probes'

const nextChord = `${shortcutModifier}+Alt+Shift+ArrowRight`
const previousChord = `${shortcutModifier}+Alt+Shift+ArrowLeft`

test.beforeEach(async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store?.getState()
    if (!state) {
      throw new Error('Store unavailable')
    }
    await state.setKeybindingOverride('tab.focusNextGroup', ['Mod+Alt+Shift+ArrowRight'])
    await state.setKeybindingOverride('tab.focusPreviousGroup', ['Mod+Alt+Shift+ArrowLeft'])
  })
})

test('moves the keyboard between one-terminal split groups in both directions', async ({
  orcaPage
}, testInfo) => {
  const fixture = await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const firstTerminalId = state?.activeTabId
    if (!state || !worktreeId || !firstTerminalId) {
      throw new Error('Active terminal unavailable')
    }
    const firstGroupId = state.ensureWorktreeRootGroup(worktreeId)
    const secondTerminal = state.createTab(worktreeId)
    const secondTab = window.__store
      ?.getState()
      .unifiedTabsByWorktree[worktreeId]?.find(
        (tab) => tab.contentType === 'terminal' && tab.entityId === secondTerminal.id
      )
    if (!secondTab) {
      throw new Error('New terminal tab unavailable')
    }
    state.dropUnifiedTab(secondTab.id, { groupId: firstGroupId, splitDirection: 'right' })
    state.focusGroup(worktreeId, firstGroupId)
    return { firstTerminalId, secondTerminalId: secondTerminal.id }
  })
  const firstInput = orcaPage.locator(
    `[data-terminal-tab-id="${fixture.firstTerminalId}"] .xterm-helper-textarea`
  )
  const secondInput = orcaPage.locator(
    `[data-terminal-tab-id="${fixture.secondTerminalId}"] .xterm-helper-textarea`
  )
  await expect(firstInput).toBeAttached()
  await expect(secondInput).toBeAttached()
  await firstInput.focus()
  await expect(firstInput).toBeFocused()

  await orcaPage.keyboard.press(nextChord)
  await expect(secondInput).toBeFocused()
  await orcaPage.keyboard.press(nextChord)
  await expect(firstInput).toBeFocused()
  await orcaPage.keyboard.press(previousChord)
  await expect(secondInput).toBeFocused()
  await orcaPage.screenshot({ path: testInfo.outputPath('split-group-keyboard-focus.png') })
})

for (const staleGroupSelection of [false, true]) {
  test(`returns from a focused browser guest with ${staleGroupSelection ? 'stale' : 'current'} group selection`, async ({
    orcaPage
  }, testInfo) => {
    const server = await startBrowserSplitPageServer()
    try {
      const url = server.pageUrl('keyboard', 1)
      const fixture = await createTerminalBrowserSplit(orcaPage, url)
      await waitForGuestUrl(orcaPage, fixture.browserTabId, url)
      await waitForBrowserGuestRegistration(orcaPage, fixture.browserTabId, fixture.browserPageId)
      const terminalInput = orcaPage.locator('.xterm-helper-textarea').first()
      await orcaPage.evaluate(({ terminalGroupId }) => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        if (state && worktreeId) {
          state.focusGroup(worktreeId, terminalGroupId)
        }
      }, fixture)
      await terminalInput.focus()
      await expect(terminalInput).toBeFocused()
      await orcaPage.keyboard.press(nextChord)
      const guest = orcaPage.locator(
        `[data-browser-overlay-tab-id="${fixture.browserTabId}"] webview`
      )
      await expect(guest).toBeFocused()
      if (staleGroupSelection) {
        await orcaPage.evaluate(({ terminalGroupId }) => {
          const state = window.__store?.getState()
          const worktreeId = state?.activeWorktreeId
          if (!state || !worktreeId) {
            throw new Error('Active workspace unavailable')
          }
          state.focusGroup(worktreeId, terminalGroupId)
        }, fixture)
      }
      const beforeGuestShortcut = await orcaPage.evaluate(({ browserGroupId }) => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        return {
          activeElement: document.activeElement?.tagName,
          selectedGroup: worktreeId ? state?.activeGroupIdByWorktree[worktreeId] : null,
          sourceGroup: browserGroupId
        }
      }, fixture)
      // Keep the guest's own input path: focusing it again in the renderer would repair the stale selection.
      await orcaPage.evaluate(async ({ browserTabId }) => {
        const webview = document.querySelector<Electron.WebviewTag>(
          `[data-browser-overlay-tab-id="${browserTabId}"] webview`
        )
        if (!webview) {
          throw new Error('Browser guest unavailable')
        }
        await webview.sendInputEvent({
          type: 'keyDown',
          keyCode: 'Left',
          modifiers: [navigator.userAgent.includes('Mac') ? 'meta' : 'control', 'alt', 'shift']
        })
        await webview.sendInputEvent({
          type: 'keyUp',
          keyCode: 'Left',
          modifiers: [navigator.userAgent.includes('Mac') ? 'meta' : 'control', 'alt', 'shift']
        })
      }, fixture)
      await expect(terminalInput).toBeFocused()
      await testInfo.attach('browser-group-keyboard-result', {
        body: JSON.stringify(
          {
            beforeGuestShortcut,
            after: await orcaPage.evaluate(() => ({
              activeElement: document.activeElement?.tagName,
              activeHtml: document.activeElement?.outerHTML.slice(0, 500),
              activeGroup:
                window.__store?.getState().activeGroupIdByWorktree[
                  window.__store.getState().activeWorktreeId ?? ''
                ]
            }))
          },
          null,
          2
        ),
        contentType: 'application/json'
      })
      await orcaPage.screenshot({ path: testInfo.outputPath('browser-group-keyboard-focus.png') })
    } finally {
      await server.close()
    }
  })
}
