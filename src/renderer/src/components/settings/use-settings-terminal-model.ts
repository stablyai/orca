import { useMemo } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'
import {
  isWindowsTerminalCapabilityHost,
  useLocalWindowsTerminalCapabilities,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { useWindowsTerminalCapabilityOwnerKey } from '@/hooks/useWindowsTerminalCapabilityOwnerKey'
import { getRepoHostIdentity } from '../../store/slices/repo-host-identity'
import { getSettingsProjectHostRepo } from './settings-project-list'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsNavigationModel } from './use-settings-navigation-model'

export function useSettingsTerminalModel(
  model: SettingsStoreModel,
  navigation: SettingsNavigationModel
) {
  const windowsTerminalCapabilityOwnerKey = useWindowsTerminalCapabilityOwnerKey(
    model.settings?.activeRuntimeEnvironmentId
  )
  const runtimeTarget = useMemo(() => getActiveRuntimeTarget(model.settings), [model.settings])
  const capabilityLoadTarget = useMemo(
    () => (model.isWebClient ? { kind: 'local' as const } : runtimeTarget),
    [model.isWebClient, runtimeTarget]
  )
  const hasActiveRuntimeEnvironment = Boolean(model.settings?.activeRuntimeEnvironmentId?.trim())
  const needsRepoWindowsRuntimeCapabilities = [...navigation.neededSectionIds].some((sectionId) =>
    sectionId.startsWith('repo-')
  )
  const needsLocalWindowsRuntimeCapabilities =
    (model.isWindows || model.isWebClient) &&
    (navigation.neededSectionIds.has('agents') || navigation.neededSectionIds.has('general'))
  const shouldLoadWindowsTerminalCapabilities =
    hasActiveRuntimeEnvironment ||
    ((model.isWindows || model.isWebClient) &&
      (navigation.neededSectionIds.has('terminal') ||
        navigation.neededSectionIds.has('accounts') ||
        needsRepoWindowsRuntimeCapabilities ||
        (runtimeTarget.kind === 'local' && needsLocalWindowsRuntimeCapabilities)))
  // Why: terminal, account, and repository settings describe the active execution host.
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    shouldLoadWindowsTerminalCapabilities,
    true,
    windowsTerminalCapabilityOwnerKey,
    capabilityLoadTarget
  )
  // Why: global agent and project defaults belong to the desktop, not its active remote.
  const remoteViewLocalWindowsRuntimeCapabilities = useLocalWindowsTerminalCapabilities(
    needsLocalWindowsRuntimeCapabilities &&
      runtimeTarget.kind === 'environment' &&
      !model.isWebClient,
    true,
    'local'
  )
  const localWindowsRuntimeCapabilities =
    runtimeTarget.kind === 'local' || model.isWebClient
      ? windowsTerminalCapabilities
      : remoteViewLocalWindowsRuntimeCapabilities
  // Why: only supported-but-unavailable WSL (Windows) should render disabled controls, not unsupported WSL (macOS/Linux).
  const runtimeWslSupportedPlatform = isWindowsTerminalCapabilityHost({
    isWindowsRenderer: model.isWindows,
    isWebClient: model.isWebClient,
    target: runtimeTarget,
    hostPlatform: windowsTerminalCapabilities.hostPlatform
  })
  const localWslSupportedPlatform = isWindowsTerminalCapabilityHost({
    isWindowsRenderer: model.isWindows,
    isWebClient: model.isWebClient,
    target: { kind: 'local' },
    hostPlatform: localWindowsRuntimeCapabilities.hostPlatform
  })
  const isWindowsTerminalHost = runtimeWslSupportedPlatform

  if ([...navigation.neededSectionIds].some((id) => !model.mountedSectionIds.has(id))) {
    // Why: record newly needed sections during render so panes don't wait for a follow-up Effect.
    model.setMountedSectionIds(navigation.neededSectionIds)
  }

  // Why: load hooks for the selected host's repo id, not the representative id (they differ for non-default hosts).
  const neededRepos = useMemo(() => {
    const reposByHostIdentity = new Map<string, Repo>()
    for (const settingsProject of model.settingsProjectList) {
      if (!navigation.neededSectionIds.has(`repo-${settingsProject.representativeRepoId}`)) {
        continue
      }
      const repo = getSettingsProjectHostRepo(
        settingsProject,
        model.repos,
        model.settingsProjectHostSelection[settingsProject.projectId],
        model.settingsProjectSetupSelection[settingsProject.projectId]
      )
      if (repo) {
        reposByHostIdentity.set(getRepoHostIdentity(repo), repo)
      }
    }
    return [...reposByHostIdentity.values()]
  }, [
    navigation.neededSectionIds,
    model.repos,
    model.settingsProjectHostSelection,
    model.settingsProjectList,
    model.settingsProjectSetupSelection
  ])

  return {
    runtimeTarget,
    windowsTerminalCapabilities,
    localWindowsRuntimeCapabilities,
    runtimeWslSupportedPlatform,
    localWslSupportedPlatform,
    isWindowsTerminalHost,
    neededRepos
  }
}

export type SettingsTerminalModel = ReturnType<typeof useSettingsTerminalModel>
