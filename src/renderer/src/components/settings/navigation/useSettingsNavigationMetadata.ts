import { shallow } from 'zustand/shallow'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useSupportedGroupHookSettings } from '../repository/hooks/use-supported-group-hook-settings'
import type { ProjectGroupSettingsEntry } from '../repository/hooks/use-supported-group-hook-settings'
import { useMemo } from 'react'
import {
  getRuntimeEnvironmentsSearchEntry,
  getWebRuntimeEnvironmentsSearchEntry
} from '@/components/settings/runtime-environments/catalog/runtime-environments-search'
import { getTerminalPaneSearchEntries } from '@/components/settings/terminal/terminal-search'
import { isMacUserAgent, isWindowsUserAgent } from '@/app-shell/platform/user-agent-platform'
import { useLinearProviderConnected } from '@/lib/work-items/linear/useLinearProviderConnected'
import { getClientCreationActionPolicy } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import {
  isWindowsTerminalCapabilityHost,
  useWindowsTerminalCapabilities
} from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { useAppStore } from '@/store/index'
import { useProjectHostSetupProjection } from '@/store/projects/use-project-host-setup-projection'
import {
  useChatSettingsOwnPermissions,
  useStructuredAgentSessionHostQueuesMessages
} from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import type { ProjectGroupingModel } from '../../../../../shared/sidebar-list/sections/project-section-grouping'
import { useBots, useBotsEnabled } from '@/lib/bot-catalog'
import type { Bot } from '../../../../../shared/bot-types'
import {
  buildCapabilitySettingsSections,
  buildSetupSettingsSections
} from './settings-navigation-capability-sections'
import { buildInterfaceSettingsSections } from './settings-navigation-interface-sections'
import {
  buildBotSettingsSections,
  buildBotsPageSettingsSections
} from './settings-navigation-bots-sections'
import {
  buildProjectSettingsSections,
  buildRemoteSettingsSections
} from './settings-navigation-remote-sections'
import { buildWorkflowSettingsSections } from './settings-navigation-workflow-sections'
import { useWindowsTerminalCapabilityOwnerKey } from '../../../runtime/hosts/capabilities/useWindowsTerminalCapabilityOwnerKey'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsNavSection } from '@/components/settings/navigation/settings-navigation-types'
import type { Repo } from '../../../../../shared/repository/repo-types'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

// Share Settings/Cmd+J visibility without Settings pane UI imports; an architecture test enforces this boundary.
// Share Settings/Cmd+J visibility without Settings pane UI imports; an architecture test enforces this boundary.

export function buildSettingsNavigationMetadata(
  {
    isMac,
    isWindows,
    isLocalWindowsHost = isWindows,
    isWindowsTerminalHost = isWindows,
    isWebClient,
    botsEnabled = true,
    hostQueuesMessages = false,
    typedChatPermissions = false,
    managedBrowserCreationEnabled = !isWebClient,
    mobileEmulatorCreationEnabled = !isWebClient,
    isDev = import.meta.env.DEV,
    isLinearConnected = false,
    repos,
    bots = [],
    projectGroups,
    projectGrouping
  }: {
    isMac: boolean
    isWindows: boolean
    isLocalWindowsHost?: boolean
    isWindowsTerminalHost?: boolean
    isWebClient: boolean
    botsEnabled?: boolean
    hostQueuesMessages?: boolean
    typedChatPermissions?: boolean
    managedBrowserCreationEnabled?: boolean
    mobileEmulatorCreationEnabled?: boolean
    isDev?: boolean
    isLinearConnected?: boolean
    projectGroups?: readonly ProjectGroupSettingsEntry[]
    repos: readonly Repo[]
    bots?: readonly Bot[]
    projectGrouping?: ProjectGroupingModel
  },
  t?: Translate
): SettingsNavSection[] {
  const terminalPaneSearchEntries = getTerminalPaneSearchEntries(
    {
      isWindows,
      isWindowsTerminalHost,
      isMac
    },
    t
  )
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
    botsEnabled,
    hostQueuesMessages,
    typedChatPermissions,
    managedBrowserCreationEnabled,
    mobileEmulatorCreationEnabled,
    isDev,
    isLinearConnected,
    repos,
    bots,
    projectGroups,
    projectGrouping
  }

  // Match SETTINGS_NAV_GROUPS order so Settings and Cmd+J keep siblings together.
  return [
    ...buildCapabilitySettingsSections(options, t),
    ...buildSetupSettingsSections(options, t),
    ...buildBotsPageSettingsSections(options),
    ...buildWorkflowSettingsSections(options, terminalPaneSearchEntries, t),
    ...buildInterfaceSettingsSections(options, t),
    ...buildRemoteSettingsSections(options, runtimeEnvironmentsSearchEntry, t),
    // Directly above Projects, as bots sit above the projects in the sidebar.
    ...buildBotSettingsSections(options),
    ...buildProjectSettingsSections(options, reposById, t)
  ]
}

export function useSettingsNavigationMetadata(): SettingsNavSection[] {
  const t = useTranslate()
  // The locale subscription must also invalidate the memo or labels retain the previous language.
  const languageRevision = useUiLanguageRevision()
  const projectGroups = useSupportedGroupHookSettings()
  const repos = useAppStore((state) => state.repos)
  const botsEnabled = useBotsEnabled()
  const bots = useBots(botsEnabled)
  const projectHostSetupProjection = useProjectHostSetupProjection()
  const settings = useAppStore((state) => state.settings)
  const [managedBrowserCreationEnabled, mobileEmulatorCreationEnabled] =
    useAppStoreWithHostStatuses((state, statuses) => {
      const policy = getClientCreationActionPolicy(state, state.activeWorktreeId, statuses)
      return [
        policy['managed-browser'].state === 'enabled',
        policy['mobile-emulator'].state === 'enabled'
      ] as const
    }, shallow)
  const typedChatPermissions = useChatSettingsOwnPermissions()
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
      buildSettingsNavigationMetadata(
        {
          isMac,
          isWindows,
          isLocalWindowsHost,
          isWindowsTerminalHost,
          isWebClient,
          botsEnabled,
          hostQueuesMessages,
          typedChatPermissions,
          managedBrowserCreationEnabled,
          mobileEmulatorCreationEnabled,
          isDev: import.meta.env.DEV,
          isLinearConnected,
          repos,
          bots,
          projectGroups,
          projectGrouping: {
            projects: projectHostSetupProjection.projects,
            projectHostSetups: projectHostSetupProjection.setups
          }
        },
        t
      ),
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- translate() inside buildSettingsNavigationMetadata reads the UI language and catalogs implicitly.
    [
      isMac,
      isWindows,
      isLocalWindowsHost,
      isWindowsTerminalHost,
      isWebClient,
      botsEnabled,
      hostQueuesMessages,
      typedChatPermissions,
      managedBrowserCreationEnabled,
      mobileEmulatorCreationEnabled,
      isLinearConnected,
      repos,
      bots,
      projectGroups,
      projectHostSetupProjection,
      languageRevision,
      t
    ]
  )
}
