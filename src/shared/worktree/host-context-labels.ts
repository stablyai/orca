import {
  getExecutionHostLabel,
  getLocalExecutionHostLabel,
  normalizeExecutionHostId,
  isLocalExecutionHost,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { GlobalSettings } from '../global-settings-types'
import { getHostDisplayLabelOverrides } from '../host-setting-overrides'

export type HostContextLabelSources = {
  /** Explicit labels (SSH target names and per-host display overrides). */
  hostLabelById?: ReadonlyMap<string, string>
  /** The execution host's platform; clients must not use the device platform. */
  hostPlatform?: NodeJS.Platform | null
}

export function getHostContextLabel(
  hostId: ExecutionHostId,
  sources: HostContextLabelSources = {}
): string {
  const override = sources.hostLabelById?.get(hostId)?.trim()
  if (override) {
    return override
  }
  if (isLocalExecutionHost(hostId)) {
    // Null means unknown paired-host platform; omission uses the desktop process platform.
    if (sources.hostPlatform === null) {
      return 'This computer'
    }
    return sources.hostPlatform !== undefined
      ? getLocalExecutionHostLabel(sources.hostPlatform)
      : getExecutionHostLabel(hostId)
  }
  return getExecutionHostLabel(hostId)
}

/** Accept raw SSH target IDs and canonical ssh: IDs emitted by different protocol versions. */
export function sshTargetSummaryHostId(targetId: string): ExecutionHostId {
  return normalizeExecutionHostId(targetId) ?? toSshExecutionHostId(targetId)
}

export function buildHostLabelById(args: {
  sshTargets: readonly { id: string; label: string }[]
  hostSettingOverrides: unknown
}): Map<ExecutionHostId, string> {
  const labels = new Map<ExecutionHostId, string>()
  for (const target of args.sshTargets) {
    const label = target.label.trim()
    if (!target.id.trim() || !label) {
      continue
    }
    labels.set(sshTargetSummaryHostId(target.id), label)
  }
  const overrides =
    args.hostSettingOverrides && typeof args.hostSettingOverrides === 'object'
      ? getHostDisplayLabelOverrides({
          hostSettingOverrides: args.hostSettingOverrides as GlobalSettings['hostSettingOverrides']
        })
      : new Map<ExecutionHostId, string>()
  for (const [hostId, label] of overrides) {
    const normalized = normalizeExecutionHostId(hostId) ?? toSshExecutionHostId(hostId)
    if (normalized) {
      labels.set(normalized, label)
    }
  }
  return labels
}

export function getMixedHostContextLabels<T>(
  items: readonly T[],
  args: {
    getHostId: (item: T) => ExecutionHostId
    getIdentity: (item: T) => string
    sources?: HostContextLabelSources
  }
): Map<string, string> | undefined {
  // Detect multiple hosts first; single-host installs need no per-row label map.
  let firstHostId: ExecutionHostId | undefined
  let isMixed = false
  for (const item of items) {
    const hostId = args.getHostId(item)
    if (firstHostId === undefined) {
      firstHostId = hostId
      continue
    }
    if (hostId !== firstHostId) {
      isMixed = true
      break
    }
  }
  if (!isMixed) {
    return undefined
  }
  const labelsByIdentity = new Map<string, string>()
  for (const item of items) {
    labelsByIdentity.set(
      args.getIdentity(item),
      getHostContextLabel(args.getHostId(item), args.sources)
    )
  }
  return labelsByIdentity
}
