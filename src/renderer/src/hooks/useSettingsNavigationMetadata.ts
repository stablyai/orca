import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  getRuntimeEnvironmentsSearchEntry,
  getWebRuntimeEnvironmentsSearchEntry
} from '@/components/settings/runtime-environments/catalog/runtime-environments-search'
import { getTerminalPaneSearchEntries } from '@/components/settings/terminal/terminal-search'
import { isMacUserAgent, isWindowsUserAgent } from '@/app-shell/platform/user-agent-platform'
import { useLinearProviderConnected } from '@/hooks/useLinearProviderConnected'
import { getClientCreationActionPolicy } from '@/lib/workspace/creation/surface-policy/client-creation-action-policy'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import {
  isWindowsTerminalCapabilityHost,
  useWindowsTerminalCapabilities
} from '@/runtime/hosts/capabilities/windows-terminal-capabilities'
import { defaultScopeHost } from '@/runtime/hosts/selection/default-creation-host'
import { useAppStore } from '@/store'
import { getProjectGroupingModelFromState } from '@/store/projects/project-host-setup-selector'
import {
  useChatSettingsOwnPermissions,
  useStructuredAgentSessionHostQueuesMessages
} from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import {
  buildCapabilitySettingsSections,
  buildSetupSettingsSections
} from './settings-navigation-capability-sections'
import { buildInterfaceSettingsSections } from './settings-navigation-interface-sections'
import { buildRemoteSettingsSections } from './settings-navigation-remote-sections'
import { buildWorkflowSettingsSections } from './settings-navigation-workflow-sections'
import { useWindowsTerminalCapabilityOwnerKey } from './useWindowsTerminalCapabilityOwnerKey'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import { useTranslate } from '@/i18n/use-translate'
import type { Translate } from '@/i18n/use-translate'
import type { SettingsNavSection } from '@/components/settings/navigation/settings-navigation-types'
import type { ProjectGroupingModel } from '../../../shared/project-section-grouping'
import type { Repo } from '../../../shared/repo-types'
import type { SettingsNavigationBuildOptions } from './settings-navigation-build-options'

// Share Settings/Cmd+J visibility without Settings pane UI imports; an architecture test enforces this boundary.

export { isWebClientLocation } from '@/app-shell/platform/web-client-location'

export function buildSettingsNavigationMetadata(
  {
    isMac,
    isWindows,
    isLocalWindowsHost = isWindows,
    isWindowsTerminalHost = isWindows,
    isWebClient,
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
    hostQueuesMessages?: boolean
    typedChatPermissions?: boolean
    managedBrowserCreationEnabled?: boolean
    mobileEmulatorCreationEnabled?: boolean
    isDev?: boolean
    isLinearConnected?: boolean
    repos: readonly Repo[]
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
  const options: SettingsNavigationBuildOptions = {
    isMac,
    isWindows,
    isLocalWindowsHost,
    isWindowsTerminalHost,
    isWebClient,
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
    ...buildCapabilitySettingsSections(options, t),
    ...buildSetupSettingsSections(options, t),
    ...buildWorkflowSettingsSections(options, terminalPaneSearchEntries, t),
    ...buildInterfaceSettingsSections(options, t),
    ...buildRemoteSettingsSections(options, runtimeEnvironmentsSearchEntry, t)
  ]
}

export function useSettingsNavigationMetadata(): SettingsNavSection[] {
  const t = useTranslate()
  // The locale subscription must also invalidate the memo or labels retain the previous language.
  const languageRevision = useUiLanguageRevision()
  const repos = useAppStore((state) => state.repos)
  const projectGrouping = useAppStore(getProjectGroupingModelFromState)
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
          hostQueuesMessages,
          typedChatPermissions,
          managedBrowserCreationEnabled,
          mobileEmulatorCreationEnabled,
          isDev: import.meta.env.DEV,
          isLinearConnected,
          repos,
          projectGrouping
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
      hostQueuesMessages,
      typedChatPermissions,
      managedBrowserCreationEnabled,
      mobileEmulatorCreationEnabled,
      isLinearConnected,
      repos,
      projectGrouping,
      languageRevision,
      t
    ]
  )
}
