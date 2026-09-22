import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
// Why: this registry mirrors the Settings sidebar in one neutral module so
// Cmd+J and Settings visibility cannot drift. Keep it free of Settings pane UI
// imports; the boundary is enforced by a focused architecture test.
import {
  getRuntimeEnvironmentsSearchEntry,
  getWebRuntimeEnvironmentsSearchEntry
} from '@/components/settings/runtime-environments-search'
import { getTerminalPaneSearchEntries } from '@/components/settings/terminal-search'
import { isMacUserAgent, isWindowsUserAgent } from '@/components/terminal-pane/pane-helpers'
import { useLinearProviderConnected } from '@/hooks/useLinearProviderConnected'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import type { SettingsNavSection } from '@/lib/settings-navigation-types'
import { isWebClientLocation } from '@/lib/web-client-location'
import {
  isWindowsTerminalCapabilityHost,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import { useAppStore } from '@/store'
import type { Repo } from '../../../shared/repo-types'
import {
  buildCapabilitySettingsSections,
  buildSetupSettingsSections
} from './settings-navigation-capability-sections'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'
import { buildInterfaceSettingsSections } from './settings-navigation-interface-sections'
import { buildRemoteSettingsSections } from './settings-navigation-remote-sections'
import { buildWorkflowSettingsSections } from './settings-navigation-workflow-sections'
import { useWindowsTerminalCapabilityOwnerKey } from './useWindowsTerminalCapabilityOwnerKey'

export { isWebClientLocation } from '@/lib/web-client-location'

export function buildSettingsNavigationMetadata({
  isMac,
  isWindows,
  isLocalWindowsHost = isWindows,
  isWindowsTerminalHost = isWindows,
  isWebClient,
  managedBrowserCreationEnabled = !isWebClient,
  mobileEmulatorCreationEnabled = !isWebClient,
  isDev = import.meta.env.DEV,
  isLinearConnected = false,
  repos
}: {
  isMac: boolean
  isWindows: boolean
  isLocalWindowsHost?: boolean
  isWindowsTerminalHost?: boolean
  isWebClient: boolean
  managedBrowserCreationEnabled?: boolean
  mobileEmulatorCreationEnabled?: boolean
  isDev?: boolean
  isLinearConnected?: boolean
  repos: readonly Repo[]
}): SettingsNavSection[] {
  const terminalPaneSearchEntries = getTerminalPaneSearchEntries({
    isWindows,
    isWindowsTerminalHost,
    isMac
  })
  const runtimeEnvironmentsSearchEntry = isWebClient
    ? getWebRuntimeEnvironmentsSearchEntry()
    : getRuntimeEnvironmentsSearchEntry()
  const reposById = new Map<string, Repo>()
  for (const repo of repos) {
    if (!reposById.has(repo.id)) {
      reposById.set(repo.id, repo)
    }
  }
  const options: SettingsNavigationBuildOptions = {
    isMac,
    isWindows,
    isLocalWindowsHost,
    isWindowsTerminalHost,
    isWebClient,
    managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled,
    isDev,
    isLinearConnected,
    repos
  }

  // Why: this array's order must mirror SETTINGS_NAV_GROUPS so the Settings
  // sidebar and the Cmd+J palette both read top-to-bottom in the same grouped
  // order — keep each new entry beside its group's siblings.
  return [
    ...buildCapabilitySettingsSections(options),
    ...buildSetupSettingsSections(options),
    ...buildWorkflowSettingsSections(options, terminalPaneSearchEntries),
    ...buildInterfaceSettingsSections(options),
    ...buildRemoteSettingsSections(options, runtimeEnvironmentsSearchEntry, reposById)
  ]
}

export function useSettingsNavigationMetadata(): SettingsNavSection[] {
  // Why: useTranslation subscribes to language changes, but the active locale
  // must also be a memo dependency below — a rerender alone returns the cached
  // previous-language sections, leaving the Settings sidebar and Cmd+J palette
  // stuck in the old language until Settings is remounted.
  const { i18n } = useTranslation()
  const activeLocale = i18n.language
  const repos = useAppStore((state) => state.repos)
  const settings = useAppStore((state) => state.settings)
  const [managedBrowserCreationEnabled, mobileEmulatorCreationEnabled] = useAppStore(
    useShallow((state) => {
      const policy = getClientCreationActionPolicy(state, state.activeWorktreeId)
      return [
        policy['managed-browser'].state === 'enabled',
        policy['mobile-emulator'].state === 'enabled'
      ] as const
    })
  )
  const isMac = isMacUserAgent()
  const isWindows = isWindowsUserAgent()
  const isWebClient = isWebClientLocation()
  const isLinearConnected = useLinearProviderConnected()
  const windowsTerminalCapabilityOwnerKey = useWindowsTerminalCapabilityOwnerKey(
    settings?.activeRuntimeEnvironmentId
  )
  const runtimeTarget = getActiveRuntimeTarget(settings)
  const capabilityLoadTarget = isWebClient ? { kind: 'local' as const } : runtimeTarget
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    isWindows || isWebClient || runtimeTarget.kind === 'environment',
    false,
    windowsTerminalCapabilityOwnerKey,
    capabilityLoadTarget
  )
  const isLocalWindowsHost = isWindowsTerminalCapabilityHost({
    isWindowsRenderer: isWindows,
    isWebClient,
    target: { kind: 'local' },
    hostPlatform:
      isWebClient || runtimeTarget.kind === 'local'
        ? windowsTerminalCapabilities.hostPlatform
        : null
  })
  const isWindowsTerminalHost = isWindowsTerminalCapabilityHost({
    isWindowsRenderer: isWindows,
    isWebClient,
    target: runtimeTarget,
    hostPlatform: windowsTerminalCapabilities.hostPlatform
  })

  // Why: Settings and Cmd+J share this metadata so platform/runtime visibility
  // and search entries cannot drift. Keep this hook free of Settings pane UI
  // imports; see docs/reference/cmd-j-settings-actions-plan.md.
  return useMemo(
    () =>
      buildSettingsNavigationMetadata({
        isMac,
        isWindows,
        isLocalWindowsHost,
        isWindowsTerminalHost,
        isWebClient,
        managedBrowserCreationEnabled,
        mobileEmulatorCreationEnabled,
        isDev: import.meta.env.DEV,
        isLinearConnected,
        repos
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- activeLocale is read implicitly by the translate() calls inside buildSettingsNavigationMetadata; without it the memo keeps the previous language's sections.
    [
      isMac,
      isWindows,
      isLocalWindowsHost,
      isWindowsTerminalHost,
      isWebClient,
      managedBrowserCreationEnabled,
      mobileEmulatorCreationEnabled,
      isLinearConnected,
      repos,
      activeLocale
    ]
  )
}
