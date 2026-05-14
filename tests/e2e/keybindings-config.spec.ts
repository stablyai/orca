import { test, expect } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import {
  discoverActivePtyId,
  execInTerminal,
  waitForActiveTerminalManager,
  waitForPaneCount,
  waitForTerminalOutput
} from './helpers/terminal'
import { waitForSessionReady, waitForActiveWorktree, ensureTerminalVisible } from './helpers/store'

const OMARCHY_COPY_PASTE_CONFIG = `
[keybindings.linux]
"terminal.copySelection" = ["super+c", "ctrl+insert"]
"terminal.paste" = ["super+v", "shift+insert"]
`

async function focusActiveTerminal(page: Page): Promise<void> {
  await page.evaluate(() => {
    const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    textarea?.focus()
  })
}

async function selectAllTerminalText(page: Page): Promise<void> {
  await page.evaluate(() => {
    const store = window.__store
    const activeTabId = store?.getState().activeTabId
    if (!activeTabId) {
      throw new Error('No active terminal tab to select')
    }

    const manager = window.__paneManagers?.get(activeTabId)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0]
    if (!pane) {
      throw new Error('No active terminal pane to select')
    }

    pane.terminal.selectAll()
  })
}

async function waitForUserTerminalBinding(page: Page, id: string): Promise<void> {
  await expect
    .poll(
      async () =>
        page.evaluate((id) => {
          const snapshot = window.__store?.getState().keybindingSnapshot
          const binding = snapshot?.keymap.bindings.find((candidate) => candidate.id === id)
          return binding?.source ?? null
        }, id),
      {
        timeout: 10_000,
        message: `${id} did not load from the user keybindings file`
      }
    )
    .toBe('user')
}

async function expectTerminalCopyAndPaste(
  page: Page,
  copyChord: string,
  pasteChord: string,
  markerPrefix: string
): Promise<void> {
  const ptyId = await discoverActivePtyId(page)
  const copyMarker = `${markerPrefix}_COPY_${Date.now()}`
  await execInTerminal(page, ptyId, `echo ${copyMarker}`)
  await waitForTerminalOutput(page, copyMarker)

  await selectAllTerminalText(page)
  await focusActiveTerminal(page)
  await page.keyboard.press(copyChord)

  await expect
    .poll(async () => page.evaluate(() => window.api.ui.readClipboardText()), {
      timeout: 5_000,
      message: `${copyChord} did not copy the terminal selection`
    })
    .toContain(copyMarker)

  const pasteMarker = `${markerPrefix}_PASTE_${Date.now()}`
  await page.evaluate((text) => window.api.ui.writeClipboardText(text), pasteMarker)
  await focusActiveTerminal(page)
  await page.keyboard.press(pasteChord)
  await waitForTerminalOutput(page, pasteMarker)
}

test.describe('Keybindings config', () => {
  test.skip(
    process.platform !== 'linux',
    'Super-key Omarchy smoke coverage is Linux-specific; macOS and Windows use separate defaults.'
  )

  test.use({ keybindingsToml: OMARCHY_COPY_PASTE_CONFIG })

  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    const hasPaneManager = await waitForActiveTerminalManager(orcaPage, 30_000)
      .then(() => true)
      .catch(() => false)
    test.skip(
      !hasPaneManager,
      'Electron automation in this environment never mounts the live TerminalPane manager.'
    )
    await waitForPaneCount(orcaPage, 1, 30_000)
    await waitForUserTerminalBinding(orcaPage, 'terminal.copySelection')
    await waitForUserTerminalBinding(orcaPage, 'terminal.paste')
  })

  test('Super+C and Super+V can be configured for terminal copy and paste', async ({
    orcaPage
  }) => {
    await expectTerminalCopyAndPaste(orcaPage, 'Meta+c', 'Meta+v', 'CONFIG_SUPER')
  })

  test('Omarchy universal copy/paste forwarding can be configured for the terminal', async ({
    orcaPage
  }) => {
    await expectTerminalCopyAndPaste(orcaPage, 'Control+Insert', 'Shift+Insert', 'CONFIG_OMARCHY')
  })
})
