import { useAppStore } from '@/store'

/**
 * True where WSL distros can be hosts: a Windows desktop (or the e2e fake) launched with the internal
 * gate open. The preload omits the API otherwise, which hides every WSL host surface.
 */
export function wslHostsAvailable(): boolean {
  return typeof window !== 'undefined' && window.api?.runtimeEnvironments?.wslHosts !== undefined
}

/** True once main reported that this build lacks the files WSL hosts deploy from. */
export function useWslHostServerFilesMissing(): boolean {
  return useAppStore((s) => s.wslHostServerFiles === 'missing')
}

/** Available, and the user-level Experimental switch (shown only behind the gate) is on. */
export function useWslHostsEnabled(): boolean {
  const enabled = useAppStore((s) => s.settings?.experimentalWslHosts === true)
  return enabled && wslHostsAvailable()
}

/** Settings → Experimental → WSL distros as hosts. */
export function openWslHostsExperimentalSetting(): void {
  const { openSettingsPage, openSettingsTarget } = useAppStore.getState()
  openSettingsPage()
  openSettingsTarget({ pane: 'experimental', repoId: null, sectionId: 'wsl-hosts' })
}
