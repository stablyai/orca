import type { Page } from '@stablyai/playwright-test'
import type {
  AgentProviderSessionKey,
  AgentProviderSessionMetadata
} from '../../../src/shared/agent-session-resume'
import type { ParsedAgentStatusPayload } from '../../../src/shared/agent-status-types'
import type { GlobalSettings } from '../../../src/shared/types'

export async function enableExperimentalNativeChat(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

export async function seedNativeChatProviderSession(
  page: Page,
  args: {
    paneKey: string
    worktreeId: string
    status: ParsedAgentStatusPayload
    terminalTitle?: string
    providerSession: Omit<AgentProviderSessionMetadata, 'key'> & {
      key?: AgentProviderSessionKey
    }
  }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, status, terminalTitle, providerSession }) => {
    window.__store?.getState().setAgentStatus(
      paneKey,
      status,
      terminalTitle,
      undefined,
      { worktreeId },
      {
        providerSession: {
          ...providerSession,
          key: providerSession.key ?? 'session_id'
        }
      }
    )
  }, args)
}

// Why: the terminal pane toggles by unified-tab id, which is not guaranteed to
// match the terminal entity id carried by the hook pane key.
export async function toggleTerminalTabToNativeChat(
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
