import {
  callRuntimeRpc,
  getActiveRuntimeTarget,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/runtime-rpc-client'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type {
  GlobalSettings,
  WorktreeVisibilityDefaults
} from '../../../../shared/global-settings-types'
import { normalizeWorktreeVisibilityDefaults } from '../../../../shared/external-worktree-visibility'
import { WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'

export type WorktreeVisibilityDefaultsByHost = Partial<
  Record<ExecutionHostId, WorktreeVisibilityDefaults | null>
>

export async function readRuntimeWorktreeVisibilityDefaults(
  environmentId: string
): Promise<WorktreeVisibilityDefaults | null | undefined> {
  const settings = await readRuntimeWorktreeSettings(environmentId)
  return settings === undefined
    ? undefined
    : (normalizeWorktreeVisibilityDefaults(settings.worktreeVisibilityDefaults) ?? null)
}

async function readRuntimeWorktreeSettings(
  environmentId: string
): Promise<Partial<GlobalSettings> | undefined> {
  try {
    const result = await callRuntimeRpc<{ settings: Partial<GlobalSettings> }>(
      { kind: 'environment', environmentId },
      'settings.get',
      undefined,
      { timeoutMs: 15_000, reuseRecentCompatibilityFailure: true }
    )
    return result.settings
  } catch {
    return undefined
  }
}

export async function readRuntimeWorktreeVisibilitySnapshot(environmentId: string): Promise<{
  defaults: WorktreeVisibilityDefaults | null | undefined
  sourceDefaultsSupported: boolean
  refreshLocalBaseRefOnWorktreeCreate: boolean
  localBaseRefSuggestionDismissed: boolean
}> {
  const settings = await readRuntimeWorktreeSettings(environmentId)
  const defaults =
    settings === undefined
      ? undefined
      : (normalizeWorktreeVisibilityDefaults(settings.worktreeVisibilityDefaults) ?? null)
  const sourceDefaultsSupported =
    defaults !== undefined &&
    (await runtimeEnvironmentSupportsCapability(
      environmentId,
      WORKTREE_VISIBILITY_SOURCE_DEFAULTS_RUNTIME_CAPABILITY,
      15_000
    ).catch(() => false))
  return {
    defaults,
    sourceDefaultsSupported,
    refreshLocalBaseRefOnWorktreeCreate: settings?.refreshLocalBaseRefOnWorktreeCreate === true,
    localBaseRefSuggestionDismissed: settings?.localBaseRefSuggestionDismissed === true
  }
}

export async function hydrateOwnerWorktreeVisibilityDefaults(
  settings: GlobalSettings,
  defaultsByHost: WorktreeVisibilityDefaultsByHost
): Promise<{
  settings: GlobalSettings
  defaultsByHost: WorktreeVisibilityDefaultsByHost
  supportedRuntimeEnvironmentId: string | null
  sourceDefaultsSupportedRuntimeEnvironmentId: string | null
}> {
  const target = getActiveRuntimeTarget(settings)
  if (target.kind !== 'environment') {
    return {
      settings,
      supportedRuntimeEnvironmentId: null,
      sourceDefaultsSupportedRuntimeEnvironmentId: null,
      defaultsByHost: {
        ...defaultsByHost,
        [LOCAL_EXECUTION_HOST_ID]: settings.worktreeVisibilityDefaults ?? { external: 'hide' }
      }
    }
  }
  const hostId = toRuntimeExecutionHostId(target.environmentId)
  const localDefaults =
    defaultsByHost[LOCAL_EXECUTION_HOST_ID] ?? settings.worktreeVisibilityDefaults
  const ownerDefaultsByHost = localDefaults
    ? { ...defaultsByHost, [LOCAL_EXECUTION_HOST_ID]: localDefaults }
    : defaultsByHost
  const { defaults, sourceDefaultsSupported, ...baseRefSettings } =
    await readRuntimeWorktreeVisibilitySnapshot(target.environmentId)
  settings = { ...settings, ...baseRefSettings }
  if (defaults) {
    return {
      settings: { ...settings, worktreeVisibilityDefaults: defaults },
      defaultsByHost: { ...ownerDefaultsByHost, [hostId]: defaults },
      supportedRuntimeEnvironmentId: target.environmentId,
      sourceDefaultsSupportedRuntimeEnvironmentId: sourceDefaultsSupported
        ? target.environmentId
        : null
    }
  }
  if (defaults === undefined) {
    const cached = ownerDefaultsByHost[hostId]
    if (cached) {
      return {
        settings: { ...settings, worktreeVisibilityDefaults: cached },
        defaultsByHost: ownerDefaultsByHost,
        supportedRuntimeEnvironmentId: target.environmentId,
        sourceDefaultsSupportedRuntimeEnvironmentId: sourceDefaultsSupported
          ? target.environmentId
          : null
      }
    }
    const { worktreeVisibilityDefaults: _unavailable, ...settingsWithoutDefaults } = settings
    return {
      settings: settingsWithoutDefaults as GlobalSettings,
      defaultsByHost: ownerDefaultsByHost,
      supportedRuntimeEnvironmentId: null,
      sourceDefaultsSupportedRuntimeEnvironmentId: null
    }
  }
  const { worktreeVisibilityDefaults: _unsupported, ...settingsWithoutDefaults } = settings
  return {
    settings: settingsWithoutDefaults as GlobalSettings,
    defaultsByHost: { ...ownerDefaultsByHost, [hostId]: null },
    supportedRuntimeEnvironmentId: null,
    sourceDefaultsSupportedRuntimeEnvironmentId: null
  }
}
