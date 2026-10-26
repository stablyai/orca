import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { focusActiveTerminalInput } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { pressKeyInBrowserGuest, waitForFocusedGroup } from './helpers/browser-split-fixture'

// The actions ship unbound, so the spec binds them the way a user would in keybindings.json.
const KEYBINDINGS_FILE = `${JSON.stringify(
  {
    version: 1,
    keybindings: {
      'tab.focusNextGroup': ['Ctrl+Alt+Shift+BracketRight'],
      'tab.focusPreviousGroup': ['Ctrl+Alt+Shift+BracketLeft']
    }
  },
  null,
  2
)}\n`
const NEXT = 'Control+Alt+Shift+BracketRight'
const PREVIOUS = 'Control+Alt+Shift+BracketLeft'

type SplitFixture = {
  terminalGroupId: string
  editorGroupId: string
  browserGroupId: string
  browserTabId: string
  browserPageId: string
}

/** Terminal | (editor over browser), so reading order crosses a nested split. */
async function createNestedSplits(page: Page, filePath: string): Promise<SplitFixture> {
  return page.evaluate((targetFilePath) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (!state || !worktreeId) {
      throw new Error('Active worktree unavailable')
    }
    const terminalGroupId = state.ensureWorktreeRootGroup(worktreeId)
    const editorGroupId = state.createEmptySplitGroup(worktreeId, terminalGroupId, 'right')
    if (!editorGroupId) {
      throw new Error('Editor split unavailable')
    }
    state.openFile(
      {
        filePath: targetFilePath,
        relativePath: 'split-focus.ts',
        worktreeId,
        language: 'typescript',
        mode: 'edit'
      },
      { targetGroupId: editorGroupId }
    )
    const browserGroupId = state.createEmptySplitGroup(worktreeId, editorGroupId, 'down')
    if (!browserGroupId) {
      throw new Error('Browser split unavailable')
    }
    const browserTab = state.createBrowserTab(worktreeId, 'about:blank', {
      activate: true,
      focusAddressBar: false,
      targetGroupId: browserGroupId
    })
    if (!browserTab.activePageId) {
      throw new Error('Browser page unavailable')
    }
    state.focusGroup(worktreeId, terminalGroupId)
    return {
      terminalGroupId,
      editorGroupId,
      browserGroupId,
      browserTabId: browserTab.id,
      browserPageId: browserTab.activePageId
    }
  }, filePath)
}

function focusedSurface(page: Page): Promise<string> {
  return page.evaluate(() => {
    const active = document.activeElement
    if (active?.classList.contains('xterm-helper-textarea')) {
      return 'terminal'
    }
    if (active?.tagName === 'WEBVIEW') {
      return 'browser'
    }
    return active?.closest('.monaco-editor') ? 'editor' : (active?.tagName ?? 'none')
  })
}

function activeTabIdsByGroup(page: Page): Promise<Record<string, string | null>> {
  return page.evaluate(() => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    const groups = worktreeId ? (state?.groupsByWorktree[worktreeId] ?? []) : []
    return Object.fromEntries(groups.map((group) => [group.id, group.activeTabId]))
  })
}

async function expectFocus(page: Page, groupId: string, surface: string): Promise<void> {
  await waitForFocusedGroup(page, groupId)
  await expect.poll(() => focusedSurface(page)).toBe(surface)
}

test.describe('tab group focus navigation', () => {
  test('cycles keyboard focus through nested splits without changing their tabs', async ({
    orcaPage,
    electronApp,
    seededRepoPath
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
    mkdirSync(path.join(isolatedHome, '.orca'), { recursive: true })
    writeFileSync(path.join(isolatedHome, '.orca', 'keybindings.json'), KEYBINDINGS_FILE)
    await orcaPage.evaluate(() => window.__store?.getState().reloadKeybindings())

    const filePath = path.join(seededRepoPath, 'split-focus.ts')
    writeFileSync(filePath, 'export const value = 1\n')
    const fixture = await createNestedSplits(orcaPage, filePath)
    await expect(orcaPage.locator('.monaco-editor:visible')).toHaveCount(1)
    await focusActiveTerminalInput(orcaPage)
    await expectFocus(orcaPage, fixture.terminalGroupId, 'terminal')
    const tabsBefore = await activeTabIdsByGroup(orcaPage)

    await orcaPage.keyboard.press(NEXT)
    await expectFocus(orcaPage, fixture.editorGroupId, 'editor')
    await orcaPage.keyboard.type('typed-')
    await expect(orcaPage.locator('.monaco-editor:visible')).toContainText('typed-export')

    await orcaPage.keyboard.press(NEXT)
    await expectFocus(orcaPage, fixture.browserGroupId, 'browser')

    // The page owns the keys while it has focus; main must hand the chord back to Orca.
    await pressKeyInBrowserGuest(orcaPage, fixture.browserTabId, fixture.browserPageId, ']', [
      'control',
      'alt',
      'shift'
    ])
    await expectFocus(orcaPage, fixture.terminalGroupId, 'terminal')

    await orcaPage.keyboard.press(PREVIOUS)
    await expectFocus(orcaPage, fixture.browserGroupId, 'browser')
    await pressKeyInBrowserGuest(orcaPage, fixture.browserTabId, fixture.browserPageId, '[', [
      'control',
      'alt',
      'shift'
    ])
    await expectFocus(orcaPage, fixture.editorGroupId, 'editor')

    expect(await activeTabIdsByGroup(orcaPage)).toEqual(tabsBefore)
  })
})
