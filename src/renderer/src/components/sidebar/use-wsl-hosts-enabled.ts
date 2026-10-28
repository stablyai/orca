import { useAppStore } from '@/store'

/** Preload exposes WSL-host APIs only when this desktop launch supports them. */
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

/** Enabled, and not serve-only: the entry points that add a host or move a project. */
export function useWslHostsAcceptNewWork(): boolean {
  const accepts = useAppStore((s) => s.wslHostsAcceptNewWork)
  return useWslHostsEnabled() && accepts
}

export function openWslHostsExperimentalSetting(): void {
  const { openSettingsPage, openSettingsTarget } = useAppStore.getState()
  openSettingsPage()
  openSettingsTarget({ pane: 'experimental', repoId: null, sectionId: 'wsl-hosts' })
}
