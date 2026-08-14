import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/types'

async function enableNativeChat(page: Parameters<typeof waitForSessionReady>[0]): Promise<void> {
  await page.evaluate(async () => {
    const settings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: settings as GlobalSettings })
  })
}

test.describe('Native chat zero-message admission (STA-3982)', () => {
  test('opens Chat UI from pane launch identity before the first agent hook', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await enableNativeChat(orcaPage)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId, leafId] = descriptor.paneKey.split(':')
    if (!tabId || !leafId) {
      throw new Error(`Invalid pane key: ${descriptor.paneKey}`)
    }

    await orcaPage.evaluate(
      ({ leafId, paneKey, tabId }) => {
        const state = window.__store?.getState()
        if (!state) {
          throw new Error('Renderer store unavailable')
        }
        state.dropAgentStatus(paneKey)
        state.registerAgentLaunchConfig(
          paneKey,
          { agentCommand: 'codex', agentArgs: '', agentEnv: {} },
          { agentType: 'codex', tabId, leafId }
        )
      },
      { leafId, paneKey: descriptor.paneKey, tabId }
    )

    await expect
      .poll(() =>
        orcaPage.evaluate((paneKey) => {
          const state = window.__store?.getState()
          return {
            agentStatus: state?.agentStatusByPaneKey[paneKey] ?? null,
            launchAgent: state?.agentLaunchConfigByPaneKey[paneKey]?.identity.agentType ?? null
          }
        }, descriptor.paneKey)
      )
      .toEqual({ agentStatus: null, launchAgent: 'codex' })

    await orcaPage.screenshot({ path: testInfo.outputPath('01-zero-message-terminal.png') })
    const showChat = orcaPage.getByRole('button', { name: 'Show chat view' })
    await expect(showChat).toBeVisible()
    await showChat.click()

    await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible()
    await expect(orcaPage.getByText('Start a chat with Codex')).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('02-zero-message-chat.png') })

    await orcaPage.getByRole('button', { name: 'Show terminal' }).click()
    await expect(orcaPage.locator('[data-native-chat-root="true"]')).toHaveCount(0)
    await orcaPage.evaluate((paneKey) => {
      window.__store?.getState().setPaneForegroundAgent(paneKey, {
        agent: null,
        shellForeground: true
      })
    }, descriptor.paneKey)
    await expect(showChat).toHaveCount(0)
    await orcaPage.screenshot({ path: testInfo.outputPath('03-confirmed-shell-no-chat.png') })

    await orcaPage.evaluate((paneKey) => {
      window.__store?.getState().clearPaneForegroundAgent(paneKey)
    }, descriptor.paneKey)
    await expect(showChat).toBeVisible()
    await orcaPage.screenshot({ path: testInfo.outputPath('04-restored-launch-identity.png') })
  })
})
