import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { startBrowserSplitPageServer } from './helpers/browser-split-page-server'

test('native chat announces background browsers and shows the exact requested page', async ({
  orcaPage,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-browser-notice-${randomUUID()}`
  const scratchDir = await mkdtemp(path.join(os.tmpdir(), 'orca-e2e-browser-notice-'))
  registerPostElectronShutdownCleanup(() => rm(scratchDir, { recursive: true, force: true }))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  await writeFile(
    transcriptPath,
    `${['user', 'assistant']
      .map((role, index) =>
        JSON.stringify({
          sessionId,
          uuid: `${sessionId}-${index}`,
          timestamp: new Date(Date.now() - (2 - index) * 1000).toISOString(),
          type: role,
          message: {
            role,
            model: 'claude-opus-4',
            content: [
              {
                type: 'text',
                text:
                  index === 0
                    ? 'Open a browser for this workspace.'
                    : 'Browser notice test conversation.'
              }
            ]
          }
        })
      )
      .join('\n')}\n`
  )
  await orcaPage.evaluate(
    async ({ paneKey, worktreeId, sessionId, transcriptPath, tabId }) => {
      const settings = await window.api.settings.set({ experimentalNativeChat: true })
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings })
      const state = store.getState()
      state.setAgentStatus(
        paneKey,
        { state: 'done', prompt: 'browser notice test', agentType: 'claude' },
        'Claude',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
      const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
      )
      if (!tab) {
        throw new Error('Terminal tab unavailable')
      }
      state.toggleTabViewMode(tab.id)
    },
    { ...descriptor, sessionId, transcriptPath, tabId }
  )
  const chat = orcaPage.locator('[data-native-chat-root="true"]')
  await expect(chat.getByText('Browser notice test conversation.', { exact: true })).toBeVisible({
    timeout: 30_000
  })
  await expect(chat.getByRole('button', { name: 'Show in Orca', exact: true })).toHaveCount(0)

  const server = await startBrowserSplitPageServer()
  try {
    async function createBackgroundPage(url: string): Promise<string> {
      const response = await orcaPage.evaluate(
        ({ worktree, url }) =>
          window.api.runtime.call({
            method: 'browser.tabCreate',
            params: { worktree, url, activate: false }
          }),
        { worktree: descriptor.worktreeId, url }
      )
      if (
        !response.ok ||
        !response.result ||
        typeof response.result !== 'object' ||
        !('browserPageId' in response.result) ||
        typeof response.result.browserPageId !== 'string'
      ) {
        throw new Error(`Browser creation failed: ${JSON.stringify(response)}`)
      }
      return response.result.browserPageId
    }
    async function screenshot(name: string): Promise<void> {
      if (process.env.ORCA_BROWSER_ACTIVITY_SCREENSHOTS !== '1') {
        return
      }
      const cdp = await orcaPage.context().newCDPSession(orcaPage)
      try {
        const { data } = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false
        })
        await writeFile(testInfo.outputPath(name), Buffer.from(data, 'base64'))
      } finally {
        await cdp.detach()
      }
    }

    const otherPage = await createBackgroundPage(server.pageUrl('other-browser', 1))
    const targetUrl = server.pageUrl('target-browser', 2)
    const targetPage = await createBackgroundPage(targetUrl)
    await expect(chat).toBeVisible()
    await expect(chat.getByRole('button', { name: 'Show in Orca', exact: true })).toHaveCount(2)
    const targetNotice = chat.getByRole('listitem').filter({ hasText: 'target-browser 2' })
    await expect(targetNotice).toBeVisible()
    await expect(targetNotice).toContainText('A browser was opened in this workspace.')
    await expect(
      targetNotice.getByRole('button', { name: 'Open site in default browser' })
    ).toBeVisible()
    await expect(orcaPage.locator(`[data-browser-page-pane-id="${targetPage}"]`)).not.toBeVisible()
    await screenshot('native-chat-browser-notice.png')

    await targetNotice.getByRole('button', { name: 'Show in Orca', exact: true }).click()
    const targetPane = orcaPage.locator(`[data-browser-page-pane-id="${targetPage}"]`)
    await expect(targetPane).toBeVisible()
    await expect(targetPane.locator('[data-orca-browser-address-bar="true"]')).toHaveValue(
      targetUrl
    )
    await expect(orcaPage.locator(`[data-browser-page-pane-id="${otherPage}"]`)).not.toBeVisible()
    await screenshot('native-chat-browser-revealed.png')
  } finally {
    await server.close()
  }
})
