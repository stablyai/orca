import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
// Share Settings/Cmd+J visibility without Settings pane UI imports; an architecture test enforces this boundary.
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
import { defaultScopeHost } from '@/lib/default-creation-host'
import { useAppStore } from '@/store'
import { useProjectHostSetupProjection } from '@/store/selectors'
import {
  useChatSettingsTypedPermissions,
  useStructuredAgentSessionHostQueuesMessages
} from '@/runtime/structured-agent-session-host-capability'
import type { ProjectGroupingModel } from '../../../shared/project-section-grouping'
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
  nativeChatEnabled = false,
  hostQueuesMessages = false,
  typedChatPermissions = false,
  managedBrowserCreationEnabled = !isWebClient,
  mobileEmulatorCreationEnabled = !isWebClient,
  isDev = import.meta.env.DEV,
  isLinearConnected = false,
  repos,
  projectGrouping
}: {
  isMac: boolean
  isWindows: boolean
  isLocalWindowsHost?: boolean
  isWindowsTerminalHost?: boolean
  isWebClient: boolean
  nativeChatEnabled?: boolean
  hostQueuesMessages?: boolean
  typedChatPermissions?: boolean
  managedBrowserCreationEnabled?: boolean
  mobileEmulatorCreationEnabled?: boolean
  isDev?: boolean
  isLinearConnected?: boolean
  repos: readonly Repo[]
  projectGrouping?: ProjectGroupingModel
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
    nativeChatEnabled,
    hostQueuesMessages,
    typedChatPermissions,
    managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled,
    isDev,
    isLinearConnected,
    repos,
    projectGrouping
  }

  // Match SETTINGS_NAV_GROUPS order so Settings and Cmd+J keep siblings together.
  return [
    ...buildCapabilitySettingsSections(options),
    ...buildSetupSettingsSections(options),
    ...buildWorkflowSettingsSections(options, terminalPaneSearchEntries),
    ...buildInterfaceSettingsSections(options),
    ...buildRemoteSettingsSections(options, runtimeEnvironmentsSearchEntry, reposById)
  ]
}

export function useSettingsNavigationMetadata(): SettingsNavSection[] {
  // The locale subscription must also invalidate the memo or labels retain the previous language.
  const { i18n } = useTranslation()
  const activeLocale = i18n.language
  const repos = useAppStore((state) => state.repos)
  const projectHostSetupProjection = useProjectHostSetupProjection()
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
  const nativeChatEnabled = settings?.experimentalNativeChat === true
  const typedChatPermissions = useChatSettingsTypedPermissions()
  const hostQueuesMessages = useStructuredAgentSessionHostQueuesMessages({ kind: 'local' })
  const isMac = isMacUserAgent()
  const isWindows = isWindowsUserAgent()
  const isWebClient = isWebClientLocation()
  const isLinearConnected = useLinearProviderConnected()
  const windowsTerminalCapabilityOwnerKey = useWindowsTerminalCapabilityOwnerKey(
    settings?.activeRuntimeEnvironmentId
  )
  // Why: navigation is shared with the palette, which has no host picker.
  const runtimeTarget = defaultScopeHost(settings)
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

  return useMemo(
    () =>
      buildSettingsNavigationMetadata({
        isMac,
        isWindows,
        isLocalWindowsHost,
        isWindowsTerminalHost,
        isWebClient,
        nativeChatEnabled,
        hostQueuesMessages,
        typedChatPermissions,
        managedBrowserCreationEnabled,
        mobileEmulatorCreationEnabled,
        isDev: import.meta.env.DEV,
        isLinearConnected,
        repos,
        projectGrouping: {
          projects: projectHostSetupProjection.projects,
          projectHostSetups: projectHostSetupProjection.setups
        }
      }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- activeLocale is read implicitly by the translate() calls inside buildSettingsNavigationMetadata; without it the memo keeps the previous language's sections.
    [
      isMac,
      isWindows,
      isLocalWindowsHost,
      isWindowsTerminalHost,
      isWebClient,
      nativeChatEnabled,
      hostQueuesMessages,
      typedChatPermissions,
      managedBrowserCreationEnabled,
      mobileEmulatorCreationEnabled,
      isLinearConnected,
      repos,
      projectHostSetupProjection,
      activeLocale
    ]
  )
}
