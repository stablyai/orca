import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { focusActiveTerminalInput, waitForPaneIdentitySnapshot } from './helpers/terminal'
import {
  splitActiveTerminalPane,
  waitForActiveTerminalManager
} from './helpers/terminal-pane-operations'
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
async function createNestedSplits(
  page: Page,
  files: { filePath: string; relativePath: string }[]
): Promise<SplitFixture> {
  return page.evaluate((targetFiles) => {
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
    // The last file opened stays active; the earlier one proves the split's tab selection is kept.
    for (const { filePath, relativePath } of targetFiles) {
      state.openFile(
        {
          filePath,
          relativePath,
          worktreeId,
          language: 'typescript',
          mode: 'edit'
        },
        { targetGroupId: editorGroupId }
      )
    }
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
  }, files)
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

function activeTabIdsByGroup(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-tab-group-strip-id]')].map((strip) => [
        strip.getAttribute('data-tab-group-strip-id') ?? '',
        [...strip.querySelectorAll('[data-tab-id][data-active="true"]')].map(
          (tab) => tab.getAttribute('data-tab-id') ?? ''
        )
      ])
    )
  )
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
    await waitForActiveTerminalManager(orcaPage)
    // A terminal split into two panes with the second one active, so return focus must pick that pane.
    await splitActiveTerminalPane(orcaPage, 'horizontal')
    await waitForPaneIdentitySnapshot(orcaPage, 2)
    const terminalPanes = orcaPage.locator('[data-terminal-tab-id] .pane[data-leaf-id]')
    await terminalPanes.first().locator('.xterm-screen').click()
    await terminalPanes.last().locator('.xterm-screen').click()
    const activeLeafId = await terminalPanes.last().getAttribute('data-leaf-id')
    expect(activeLeafId).toBeTruthy()
    const activeLeafInput = orcaPage.locator(
      `[data-leaf-id="${activeLeafId}"] .xterm-helper-textarea`
    )
    const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
    mkdirSync(path.join(isolatedHome, '.orca'), { recursive: true })
    writeFileSync(path.join(isolatedHome, '.orca', 'keybindings.json'), KEYBINDINGS_FILE)
    await orcaPage.evaluate(() => window.__store?.getState().reloadKeybindings())

    const files = ['split-other.ts', 'split-focus.ts'].map((relativePath) => {
      const filePath = path.join(seededRepoPath, relativePath)
      writeFileSync(filePath, 'export const value = 1\n')
      return { filePath, relativePath }
    })
    const fixture = await createNestedSplits(orcaPage, files)
    await expect(orcaPage.locator('.monaco-editor:visible')).toHaveCount(1)
    await focusActiveTerminalInput(orcaPage)
    await expectFocus(orcaPage, fixture.terminalGroupId, 'terminal')
    await expect(activeLeafInput).toBeFocused()
    const tabsBefore = await activeTabIdsByGroup(orcaPage)
    await expect(
      orcaPage.locator(
        `[data-tab-group-strip-id="${fixture.editorGroupId}"] [data-tab-id][data-active="true"]`
      )
    ).toContainText('split-focus.ts')

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
    await expect(activeLeafInput).toBeFocused()

    await orcaPage.keyboard.press(PREVIOUS)
    await expectFocus(orcaPage, fixture.browserGroupId, 'browser')
    await pressKeyInBrowserGuest(orcaPage, fixture.browserTabId, fixture.browserPageId, '[', [
      'control',
      'alt',
      'shift'
    ])
    await expectFocus(orcaPage, fixture.editorGroupId, 'editor')

    expect(await activeTabIdsByGroup(orcaPage)).toEqual(tabsBefore)

    // Rich Markdown is contentEditable, where the terminal's own reveal focus steps aside,
    // so only the shortcut decides which of the two terminal panes receives keys.
    const markdownPath = path.join(seededRepoPath, 'split-notes.md')
    writeFileSync(markdownPath, 'split notes\n')
    await orcaPage.evaluate(
      ({ filePath, groupId }) => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        if (!state || !worktreeId) {
          throw new Error('Active worktree unavailable')
        }
        state.openFile(
          {
            filePath,
            relativePath: 'split-notes.md',
            worktreeId,
            language: 'markdown',
            mode: 'edit'
          },
          { targetGroupId: groupId }
        )
      },
      { filePath: markdownPath, groupId: fixture.editorGroupId }
    )
    await orcaPage.locator('.rich-markdown-editor').click()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () =>
            document.activeElement instanceof HTMLElement &&
            document.activeElement.isContentEditable
        )
      )
      .toBe(true)
    await orcaPage.keyboard.press(PREVIOUS)
    await expectFocus(orcaPage, fixture.terminalGroupId, 'terminal')
    await expect(activeLeafInput).toBeFocused()
  })
})
