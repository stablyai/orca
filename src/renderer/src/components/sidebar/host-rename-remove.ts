import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  clearHostSettingOverride,
  getHostSettingOverride,
  setHostSettingOverride
} from '../../../../shared/host-setting-overrides'
import type { GlobalSettings, HostSettingOverrides } from '../../../../shared/types'

type OverridesSlice = Pick<GlobalSettings, 'hostSettingOverrides'>
type OverridesMap = Partial<Record<ExecutionHostId, HostSettingOverrides>>

/** The current user-chosen display-label override for a host, or undefined when
 *  the host still uses its derived label. */
export function getHostDisplayLabelOverride(
  settings: OverridesSlice | null | undefined,
  hostId: ExecutionHostId
): string | undefined {
  return getHostSettingOverride(settings, hostId, 'displayLabel')
}

/** Computes the next `hostSettingOverrides` after a rename. A blank label clears
 *  the override so the host reverts to its derived label. */
export function applyHostRename(
  settings: OverridesSlice | null | undefined,
  hostId: ExecutionHostId,
  nextLabel: string
): OverridesMap {
  return setHostSettingOverride(settings, hostId, 'displayLabel', nextLabel)
}

/** Computes the next `hostSettingOverrides` after resetting a host's label. */
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

/** Resolves how a host should be removed. SSH targets are removed inline via the
 *  ssh API; runtime environments deep-link into the Orca servers pane because
 *  their removal needs active-environment/error context that lives there. */
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
