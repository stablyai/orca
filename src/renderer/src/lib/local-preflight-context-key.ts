import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'

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
