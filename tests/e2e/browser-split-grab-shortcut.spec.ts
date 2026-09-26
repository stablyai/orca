// STA-3319 / STA-8147: Cmd/Ctrl+C arms element grab only in the focused split, and never
// while text is selected elsewhere in the window (that press is a copy).

import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  browserOverlay,
  createBrowserSplit,
  createTerminalBrowserSplit,
  shortcutModifier,
  waitForFocusedGroup
} from './helpers/browser-split-fixture'
import { waitForGuestUrl } from './helpers/browser-split-guest-probes'
import {
  startBrowserSplitPageServer,
  type BrowserSplitPageServer
} from './helpers/browser-split-page-server'

const copyChord = `${shortcutModifier}+c`

function grabBanner(page: Page, browserTabId: string) {
  return browserOverlay(page, browserTabId).getByText(/Click or hover an element|Grab failed/)
}

function reloadButton(page: Page, browserTabId: string) {
  return browserOverlay(page, browserTabId).getByRole('button', { name: 'Reload', exact: true })
}

async function readClipboard(app: ElectronApplication): Promise<string> {
  return app.evaluate(({ clipboard }) => clipboard.readText())
}

async function writeClipboard(app: ElectronApplication, text: string): Promise<void> {
  await app.evaluate(({ clipboard }, value) => clipboard.writeText(value), text)
}

async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
}

/** Arms grab from the pane's toolbar: the presence check that makes a missing banner meaningful. */
async function expectToolbarCopyChordArmsGrab(page: Page, browserTabId: string): Promise<void> {
  await clearSelection(page)
  await reloadButton(page, browserTabId).focus()
  await page.keyboard.press(copyChord)
  await expect(grabBanner(page, browserTabId)).toBeVisible()
}

async function enableNativeChat(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings })
  })
}

function claudeTranscript(sessionId: string, reply: string): string {
  const rows = [
    { type: 'user', text: 'Explain the split shortcut fix.' },
    { type: 'assistant', text: reply }
  ]
  return `${rows
    .map((row, index) =>
      JSON.stringify({
        sessionId,
        uuid: `${sessionId}-${index}`,
        timestamp: new Date(Date.now() - (rows.length - index) * 1_000).toISOString(),
        type: row.type,
        message: {
          role: row.type,
          model: 'claude-opus-4',
          content: [{ type: 'text', text: row.text }]
        }
      })
    )
    .join('\n')}\n`
}

/** Turns the terminal split into a native chat view over a seeded Claude transcript. */
async function openNativeChatTranscript(
  page: Page,
  args: { paneKey: string; worktreeId: string; reply: string }
): Promise<void> {
  const sessionId = `e2e-split-grab-${randomUUID()}`
  const transcriptPath = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-split-grab-')),
    `${sessionId}.jsonl`
  )
  writeFileSync(transcriptPath, claudeTranscript(sessionId, args.reply))
  await enableNativeChat(page)
  await page.evaluate(
    ({ paneKey, worktreeId, transcriptSessionId, transcriptFile }) => {
      const state = window.__store?.getState()
      if (!state) {
        throw new Error('Store unavailable')
      }
      state.setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'e2e split grab probe', agentType: 'claude' },
        'Claude',
        undefined,
        { worktreeId },
        {
          providerSession: {
            key: 'session_id',
            id: transcriptSessionId,
            transcriptPath: transcriptFile
          }
        }
      )
      const [tabId] = paneKey.split(':')
      const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
      )
      if (!unifiedTab) {
        throw new Error('Unified terminal tab not found for chat toggle')
      }
      state.toggleTabViewMode(unifiedTab.id)
    },
    {
      paneKey: args.paneKey,
      worktreeId: args.worktreeId,
      transcriptSessionId: sessionId,
      transcriptFile: transcriptPath
    }
  )
  await expect(page.locator('[data-native-chat-window]')).toBeVisible({ timeout: 30_000 })
}

test.describe('browser split grab shortcut', () => {
  // Why: these tests share the system clipboard, so keep them on one worker.
  test.describe.configure({ mode: 'default' })

  let server: BrowserSplitPageServer
  let savedClipboard: string | null = null

  test.beforeEach(async ({ electronApp, orcaPage }) => {
    server = await startBrowserSplitPageServer()
    // Why: the copy assertions read the real system clipboard; put the user's text back after.
    savedClipboard = await readClipboard(electronApp)
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
  })

  test.afterEach(async ({ electronApp }) => {
    if (savedClipboard !== null) {
      await writeClipboard(electronApp, savedClipboard)
    }
    await server.close()
  })

  test('copy chord from one split toolbar arms grab only in that split', async ({ orcaPage }) => {
    const fixture = await createBrowserSplit(orcaPage, {
      first: server.pageUrl('a', 1),
      second: server.pageUrl('b', 1, 'localhost')
    })
    await waitForGuestUrl(orcaPage, fixture.firstBrowserTabId, server.pageUrl('a', 1))
    await waitForGuestUrl(orcaPage, fixture.secondBrowserTabId, server.pageUrl('b', 1, 'localhost'))

    await reloadButton(orcaPage, fixture.firstBrowserTabId).focus()
    await waitForFocusedGroup(orcaPage, fixture.firstBrowserGroupId)
    await orcaPage.keyboard.press(copyChord)

    await expect(grabBanner(orcaPage, fixture.firstBrowserTabId)).toBeVisible()
    await expect(grabBanner(orcaPage, fixture.secondBrowserTabId)).toBeHidden()
  })

  test('copy chord with native chat text selected copies instead of arming grab', async ({
    electronApp,
    orcaPage
  }) => {
    await waitForActiveTerminalManager(orcaPage, 30_000)
    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const fixture = await createTerminalBrowserSplit(orcaPage, server.pageUrl('a', 1))
    await waitForGuestUrl(orcaPage, fixture.browserTabId, server.pageUrl('a', 1))
    const reply = `Selectable transcript reply ${randomUUID()}`
    await openNativeChatTranscript(orcaPage, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      reply
    })
    await writeClipboard(electronApp, 'clipboard before copy')

    const replyText = orcaPage.locator('[data-native-chat-window]').getByText(reply)
    await replyText.click({ clickCount: 3 })
    await expect
      .poll(() => orcaPage.evaluate(() => window.getSelection()?.toString()))
      .toContain(reply)
    await orcaPage.keyboard.press(copyChord)

    await expect.poll(() => readClipboard(electronApp)).toContain(reply)
    await expect(grabBanner(orcaPage, fixture.browserTabId)).toBeHidden()

    // Why: with the browser split focused, only the live-selection check can tell this is a copy.
    await writeClipboard(electronApp, 'clipboard before copy')
    await reloadButton(orcaPage, fixture.browserTabId).focus()
    await waitForFocusedGroup(orcaPage, fixture.browserGroupId)
    expect(await orcaPage.evaluate(() => window.getSelection()?.toString())).toContain(reply)
    await orcaPage.keyboard.press(copyChord)
    await expect.poll(() => readClipboard(electronApp)).toContain(reply)
    await expect(grabBanner(orcaPage, fixture.browserTabId)).toBeHidden()

    await expectToolbarCopyChordArmsGrab(orcaPage, fixture.browserTabId)
  })
})
