import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/types'

// Native chat over ACP, end to end: this spawns a real `hermes acp` agent, so it
// proves the transport in the assembled app rather than against a fake client.
// Mirrors native-chat-first-flush-race.spec.ts for the store-seeding technique —
// seeding agentStatusByPaneKey exercises the identical store -> NativeChatView
// path a real launch would drive, without depending on how hermes is started.

const LOADING_TITLE = 'Loading conversation…'
const ERROR_TITLE = 'Could not load conversation'

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

/** Seed a hermes provider session. Unlike the transcript agents there is no
 *  transcriptPath: an ACP conversation has no file, which is the whole point. */
async function seedHermesProviderSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'e2e acp native chat probe', agentType: 'hermes' },
        'Hermes',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId } }
      )
  }, args)
}

async function toggleTerminalTabToChatView(
  page: Page,
  args: { tabId: string; worktreeId: string }
): Promise<void> {
  await page.evaluate(({ tabId, worktreeId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
    )
    if (!unifiedTab) {
      throw new Error('Unified terminal tab not found for chat toggle')
    }
    state.toggleTabViewMode(unifiedTab.id)
  }, args)
}

test.describe('Native chat over ACP (hermes)', () => {
  // `hermes acp` starts a real agent (config load + MCP registration), so this
  // needs more than the 120s default.
  test.setTimeout(300_000)

  test('opens the chat view for a hermes session and reaches a non-error state', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-acp-${randomUUID()}`

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `native-chat-acp-hermes-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    await enableNativeChatSetting(orcaPage)
    await seedHermesProviderSession(orcaPage, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      sessionId
    })
    await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

    // Why absence is asserted by reading document text rather than with a
    // locator: in this Electron harness ANY locator assertion that matches zero
    // elements resolves `undefined` and burns the whole test timeout
    // (toHaveCount(0) and toBeHidden() both). Locators that DO match settle
    // immediately, so positive waits stay as normal expect(...).toBeVisible().
    //
    // The gate is what this asserts first: before this change the toggle refused
    // hermes outright and no chat root ever mounted.
    await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible({
      timeout: 15_000
    })

    // Wait on the positive signal rather than the absence of the loading title:
    // the chat surface is addressed to the agent by name, so this is proof the
    // view mounted and settled for hermes specifically, not a generic empty pane.
    // (`hermes acp` loads config and registers MCP servers before answering
    // initialize, so the view legitimately shows LOADING_TITLE while it starts.)
    await expect(orcaPage.getByText('Start a chat with Hermes')).toBeVisible({
      timeout: 120_000
    })
    const bodyText = await orcaPage.evaluate(() => document.body.innerText)
    expect(bodyText).not.toContain(ERROR_TITLE)
    expect(bodyText).not.toContain(LOADING_TITLE)
    // Why no screenshot: neither capture path works in this headless Electron.
    // page.screenshot() logs "fonts loaded" then hangs to its timeout, and
    // webContents.capturePage() closes the window out from under the test. The
    // rendered surface is captured instead by Playwright's own page snapshot in
    // the failure/trace artifacts, which is what proved this view mounts.
    const finalText = await orcaPage.evaluate(() => document.body.innerText)
    expect(finalText).toContain('Start a chat with Hermes')
  })
})
