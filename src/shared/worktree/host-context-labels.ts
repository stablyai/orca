import {
  getExecutionHostLabel,
  getLocalExecutionHostLabel,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../execution-host'
import type { GlobalSettings } from '../global-settings-types'
import { getHostDisplayLabelOverrides } from '../host-setting-overrides'

/** Inputs used by every client when spelling a host in a workspace row. */
export type HostContextLabelSources = {
  /** Explicit labels (SSH target names and per-host display overrides). */
  hostLabelById?: ReadonlyMap<string, string>
  /** The execution host's platform; clients must not use the device platform. */
  hostPlatform?: NodeJS.Platform | null
}

/** Canonical user-facing host label used by desktop and mobile workspace rows. */
export function getHostContextLabel(
  hostId: ExecutionHostId,
  sources: HostContextLabelSources = {}
): string {
  const override = sources.hostLabelById?.get(hostId)?.trim()
  if (override) {
    return override
  }
  if (parseExecutionHostId(hostId)?.kind === 'local') {
    // An explicit null means the paired host platform is unknown (mobile); an
    // omitted platform means use the current process (desktop).
    if (sources.hostPlatform === null) {
      return 'This computer'
    }
    return sources.hostPlatform !== undefined
      ? getLocalExecutionHostLabel(sources.hostPlatform)
      : getExecutionHostLabel(hostId)
  }
  return getExecutionHostLabel(hostId)
}

/**
 * Build labels for SSH targets and apply persisted display-name overrides.
 * Target summaries have appeared both as raw target ids and canonical `ssh:` ids
 * across protocol versions, so accept either representation.
 */
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
    const hostId = normalizeExecutionHostId(target.id) ?? toSshExecutionHostId(target.id)
    if (hostId) {
      labels.set(hostId, label)
    }
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

/** Generic mixed-host projection shared by desktop grouping and mobile sections. */
export function getMixedHostContextLabels<T>(
  items: readonly T[],
  args: {
    getHostId: (item: T) => ExecutionHostId
    getIdentity: (item: T) => string
    sources?: HostContextLabelSources
  }
): Map<string, string> | undefined {
  // Why two passes: on a single-host install the map is built for every item and then discarded.
  // Deciding first costs one getHostId per item and skips the label work entirely.
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
