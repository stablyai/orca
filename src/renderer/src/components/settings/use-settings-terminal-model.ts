import { useMemo } from 'react'
import type { Repo } from '../../../../shared/repo-types'
import {
  isWindowsTerminalCapabilityHost,
  useLocalWindowsTerminalCapabilities,
  useWindowsTerminalCapabilities
} from '@/lib/windows-terminal-capabilities'
import { useWindowsTerminalCapabilityOwnerKey } from '@/hooks/useWindowsTerminalCapabilityOwnerKey'
import { getRepoHostIdentity } from '../../store/slices/repo-host-identity'
import { getSettingsEntryHostSelection, getSettingsProjectHostRepo } from './settings-project-list'
import type { SettingsStoreModel } from './use-settings-store-model'
import type { SettingsNavigationModel } from './use-settings-navigation-model'
import { runtimeTargetEnvironmentId } from '@/runtime/runtime-client-target'

export function useSettingsTerminalModel(
  model: SettingsStoreModel,
  navigation: SettingsNavigationModel
) {
  const scopeEnvironmentId = runtimeTargetEnvironmentId(model.settingsHostScope.target)
  const windowsTerminalCapabilityOwnerKey = useWindowsTerminalCapabilityOwnerKey(scopeEnvironmentId)
  const runtimeTarget = model.settingsHostScope.target
  const capabilityLoadTarget = useMemo(
    () => (model.isWebClient ? { kind: 'local' as const } : runtimeTarget),
    [model.isWebClient, runtimeTarget]
  )
  const hasActiveRuntimeEnvironment = scopeEnvironmentId !== null
  const needsRepoWindowsRuntimeCapabilities = [...navigation.neededSectionIds].some((sectionId) =>
    sectionId.startsWith('repo-')
  )
  const needsLocalWindowsRuntimeCapabilities =
    (model.isWindows || model.isWebClient) &&
    (navigation.neededSectionIds.has('agents') || navigation.neededSectionIds.has('general'))
  // Removed servers have no capabilities to load; never probe a substitute host.
  const shouldLoadWindowsTerminalCapabilities =
    model.settingsHostScope.available &&
    (hasActiveRuntimeEnvironment ||
      ((model.isWindows || model.isWebClient) &&
        (navigation.neededSectionIds.has('terminal') ||
          navigation.neededSectionIds.has('accounts') ||
          needsRepoWindowsRuntimeCapabilities ||
          (runtimeTarget.kind === 'local' && needsLocalWindowsRuntimeCapabilities))))
  // Capabilities describe the host selected in Settings.
  const windowsTerminalCapabilities = useWindowsTerminalCapabilities(
    shouldLoadWindowsTerminalCapabilities,
    true,
    windowsTerminalCapabilityOwnerKey,
    capabilityLoadTarget
  )
  // Global agent/project defaults belong to the desktop despite the active remote.
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
  // Only Windows can show unavailable WSL controls; unsupported platforms must hide them.
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
    // Record needed sections during render to avoid a blank pass before an effect.
    model.setMountedSectionIds(navigation.neededSectionIds)
  }

  // Load hooks from the selected host’s repo ID, which may differ from the representative.
  const neededRepos = useMemo(() => {
    const reposByHostIdentity = new Map<string, Repo>()
    for (const settingsProject of model.settingsProjectList) {
      if (!navigation.neededSectionIds.has(`repo-${settingsProject.representativeRepoId}`)) {
        continue
      }
      const hostSelection = getSettingsEntryHostSelection(
        settingsProject,
        model.settingsProjectHostSelection,
        model.settingsProjectSetupSelection
      )
      const repo = getSettingsProjectHostRepo(
        settingsProject,
        model.repos,
        hostSelection.hostId,
        hostSelection.setupId
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
