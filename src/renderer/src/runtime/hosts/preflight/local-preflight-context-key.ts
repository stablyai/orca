import type { ProjectExecutionRuntimeResolution } from '../../../../../shared/execution-host/project-execution-runtime'

type LocalPreflightContextKeyInput =
  | {
      wslDistro?: string | null
      wslDefault?: boolean
      runtimeContextKey?: string
      projectRuntime?: ProjectExecutionRuntimeResolution
    }
  | undefined

export function localPreflightContextKey(context: LocalPreflightContextKeyInput): string {
  if (context?.projectRuntime) {
    return context.projectRuntime.status === 'resolved'
      ? context.projectRuntime.runtime.cacheKey
      : context.projectRuntime.repair.cacheKey
  }
  if (context?.runtimeContextKey) {
    return context.runtimeContextKey
  }
  if (context?.wslDistro) {
    return `wsl:${context.wslDistro}`
  }
  return context?.wslDefault ? 'wsl:default' : 'host'
}

const COMPLETE_INVENTORY_SUFFIX = '\u0000all-agents'

/** Native agent detection uses process PATH, independent of the project's directory. */
export function localAgentInventoryContextKey(
  context: LocalPreflightContextKeyInput,
  includeDisabled = false
): string {
  const key =
    context?.projectRuntime?.status === 'resolved' && context.projectRuntime.runtime.kind !== 'wsl'
      ? 'host'
      : localPreflightContextKey(context)
  return includeDisabled ? completeLocalAgentInventoryKey(key) : key
}

/** The inventory key that also lists disabled agents for an enabled-only inventory key. */
export function completeLocalAgentInventoryKey(enabledOnlyKey: string): string {
  return `${enabledOnlyKey}${COMPLETE_INVENTORY_SUFFIX}`
}

export function isCompleteLocalAgentInventoryKey(contextKey: string): boolean {
  return contextKey.endsWith(COMPLETE_INVENTORY_SUFFIX)
}

export function enabledOnlyLocalAgentInventoryKey(contextKey: string): string {
  return isCompleteLocalAgentInventoryKey(contextKey)
    ? contextKey.slice(0, -COMPLETE_INVENTORY_SUFFIX.length)
    : contextKey
}
