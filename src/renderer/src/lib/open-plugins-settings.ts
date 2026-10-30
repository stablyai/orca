import { useAppStore } from '@/store'

export function openPluginsSettings(): void {
  const state = useAppStore.getState()
  state.openSettingsTarget({ pane: 'plugins', repoId: null })
  state.openSettingsPage()
}
