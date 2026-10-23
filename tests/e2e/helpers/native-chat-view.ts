import type { Page } from '@stablyai/playwright-test'
import type { AgentType } from '../../../src/shared/agent-status-types'
import { waitForActivePaneHookDescriptor } from './terminal'

export async function showActivePaneAsNativeChat(
  page: Page,
  agentType: AgentType,
  title: string
): Promise<void> {
  const descriptor = await waitForActivePaneHookDescriptor(page)
  await page.evaluate(
    async ({ paneKey, worktreeId, agentType, title }) => {
      const settings = await window.api.settings.set({ experimentalNativeChat: true })
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings })
      const state = store.getState()
      state.setAgentStatus(paneKey, { state: 'idle', agentType, prompt: '' }, title, undefined, {
        worktreeId
      })
      const [tabId] = paneKey.split(':')
      const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
      )
      if (!tab) {
        throw new Error('Terminal tab unavailable')
      }
      state.toggleTabViewMode(tab.id)
    },
    { ...descriptor, agentType, title }
  )
}
