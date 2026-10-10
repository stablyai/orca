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
import { getSettingsHostScopeEnvironmentId } from './settings-host-scope'

export function useSettingsTerminalModel(
  model: SettingsStoreModel,
  navigation: SettingsNavigationModel
) {
  const scopeEnvironmentId = getSettingsHostScopeEnvironmentId(model.settingsHostScope)
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
  // Why: a server that is no longer saved has no capabilities to load; never probe another host.
  const shouldLoadWindowsTerminalCapabilities =
    model.settingsHostScope.available &&
    (hasActiveRuntimeEnvironment ||
      ((model.isWindows || model.isWebClient) &&
        (navigation.neededSectionIds.has('terminal') ||
          navigation.neededSectionIds.has('accounts') ||
          needsRepoWindowsRuntimeCapabilities ||
          (runtimeTarget.kind === 'local' && needsLocalWindowsRuntimeCapabilities))))
  // Why: terminal, account, and repository settings describe the host chosen in the page.
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
