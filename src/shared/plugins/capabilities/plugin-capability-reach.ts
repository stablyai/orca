import type { PluginCapabilityKind } from './plugin-capabilities'
import type { PluginExecutionProfile } from '../contributions/plugin-execution-profile'

/** Capabilities only a full-access worker can use: panels get no host method for them. */
const WORKER_ONLY_CAPABILITIES: ReadonlySet<string> = new Set<PluginCapabilityKind>([
  'terminal:send'
])

/** Whether a plugin of this profile can ever exercise the capability, so consent may name it. */
export function pluginCapabilityReachable(
  kind: string,
  execution: PluginExecutionProfile
): boolean {
  return execution === 'trusted-worker' || !WORKER_ONLY_CAPABILITIES.has(kind)
}

/** Drops grants the plugin can never use, so approvals never warn about them. */
export function reachablePluginCapabilities<T extends { kind: string }>(
  capabilities: readonly T[],
  execution: PluginExecutionProfile
): T[] {
  return capabilities.filter((capability) => pluginCapabilityReachable(capability.kind, execution))
}
