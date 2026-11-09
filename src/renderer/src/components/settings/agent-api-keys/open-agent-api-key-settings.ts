import { useAppStore } from '@/store'

/** Seam for in-pane sign-in prompts ("Use an API key instead"): opens Settings at the agent key list. */
export function openAgentApiKeySettings(): void {
  const state = useAppStore.getState()
  state.openSettingsPage()
  state.openSettingsTarget({ pane: 'agent-api-keys', repoId: null })
}
