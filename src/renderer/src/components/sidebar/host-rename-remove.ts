import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  clearHostSettingOverride,
  getHostSettingOverride,
  setHostSettingOverride
} from '../../../../shared/host-setting-overrides'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { HostSettingOverrides } from '../../../../shared/host-setting-overrides'

type OverridesSlice = Pick<GlobalSettings, 'hostSettingOverrides'>
type OverridesMap = Partial<Record<ExecutionHostId, HostSettingOverrides>>

/** Undefined means the host uses its derived label. */
export function getHostDisplayLabelOverride(
  settings: OverridesSlice | null | undefined,
  hostId: ExecutionHostId
): string | undefined {
  return getHostSettingOverride(settings, hostId, 'displayLabel')
}

/** A blank rename clears the override and restores the derived label. */
export function applyHostRename(
  settings: OverridesSlice | null | undefined,
  hostId: ExecutionHostId,
  nextLabel: string
): OverridesMap {
  return setHostSettingOverride(settings, hostId, 'displayLabel', nextLabel)
}

export function clearHostRename(
  settings: OverridesSlice | null | undefined,
  hostId: ExecutionHostId
): OverridesMap {
  return clearHostSettingOverride(settings, hostId, 'displayLabel')
}

export type HostRemovalTarget =
  | { kind: 'ssh'; targetId: string }
  | { kind: 'runtime'; environmentId: string }
  | null

/** Runtime removal needs server-pane context; SSH targets can be removed inline. */
export function resolveHostRemoval(hostId: ExecutionHostId): HostRemovalTarget {
  const parsed = parseExecutionHostId(hostId)
  if (parsed?.kind === 'ssh') {
    return { kind: 'ssh', targetId: parsed.targetId }
  }
  if (parsed?.kind === 'runtime') {
    return { kind: 'runtime', environmentId: parsed.environmentId }
  }
  return null
}
