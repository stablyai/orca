import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isWslHostRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/runtime-environments'
import { isWslHostsSettingOn } from '../../../../shared/remote-runtime/wsl-hosts/wsl-hosts-setting'

/** Preload exposes WSL-host APIs only when this desktop launch supports them. */
export function wslHostsAvailable(): boolean {
  return typeof window !== 'undefined' && window.api?.runtimeEnvironments?.wslHosts !== undefined
}

/** True once main reported that this build lacks the files WSL hosts deploy from. */
export function useWslHostServerFilesMissing(): boolean {
  return useAppStore((s) => s.wslHostServerFiles === 'missing')
}

/**
 * Saved hosts serve their projects whatever the setting: it governs new work only, so
 * with it off a moved project stays reachable, as in serve-only.
 */
export function selectWslHostsServing(state: {
  settings: AppState['settings']
  /** Optional: some list builders run before the environments load. */
  runtimeEnvironments?: AppState['runtimeEnvironments']
}): boolean {
  return (
    isWslHostsSettingOn(state.settings) ||
    (state.runtimeEnvironments ?? []).some(isWslHostRuntimeEnvironment)
  )
}

/** Available, and serving: the setting is on, or saved hosts keep serving with it off. */
export function useWslHostsEnabled(): boolean {
  const serving = useAppStore(selectWslHostsServing)
  return serving && wslHostsAvailable()
}

/** Available, and the user's WSL hosts setting is on. */
export function useWslHostsSettingOn(): boolean {
  const settingOn = useAppStore((s) => isWslHostsSettingOn(s.settings))
  return settingOn && wslHostsAvailable()
}

/** The setting on, and not serve-only: the entry points that add a host or move a project. */
export function useWslHostsAcceptNewWork(): boolean {
  const accepts = useAppStore((s) => s.wslHostsAcceptNewWork)
  return useWslHostsSettingOn() && accepts
}

/** Serve-only: saved hosts work, but adding hosts and moving projects is paused. */
export function useWslHostsPaused(): boolean {
  const paused = useAppStore((s) => s.wslHostsNewWorkPaused)
  return paused && wslHostsAvailable()
}

export function openWslHostsSetting(): void {
  const { openSettingsPage, openSettingsTarget } = useAppStore.getState()
  openSettingsPage()
  openSettingsTarget({ pane: 'servers', repoId: null, sectionId: 'wsl-hosts' })
}
