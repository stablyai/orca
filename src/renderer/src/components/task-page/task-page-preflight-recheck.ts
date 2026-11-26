import type { PreflightStatus } from '../../../../preload/api/preflight/preflight-api'
import type { TaskProvider } from '../../../../shared/work-items/task-providers'

/** A repo-backed provider that is installed but signed out is equally stale. */
export function needsTargetedPreflightRefresh(args: {
  taskSource: TaskProvider
  hasRepoContexts: boolean
  preflightStatus: PreflightStatus | null
  preflightStatusChecked: boolean
  preflightStatusCurrent: boolean
  preflightDescribesDesktop: boolean
}): boolean {
  if (
    !args.hasRepoContexts ||
    !args.preflightStatusCurrent ||
    !args.preflightStatusChecked ||
    !args.preflightDescribesDesktop
  ) {
    return false
  }
  const tool =
    args.taskSource === 'github'
      ? args.preflightStatus?.gh
      : args.taskSource === 'gitlab'
        ? args.preflightStatus?.glab
        : undefined
  return tool !== undefined && (!tool.installed || !tool.authenticated)
}
