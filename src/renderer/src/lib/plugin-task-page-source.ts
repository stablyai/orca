import type { TaskPageData } from '@/store/slices/ui/ui-slice-contract-core'
import { parsePluginTaskSourceKey } from '../../../shared/plugins/plugin-task-source-ref'

/** True when the opener asked for a built-in source, item, or repo scope. */
export function taskPageDataRequestsBuiltin(data: TaskPageData): boolean {
  return Boolean(
    data.taskSource ||
    data.preselectedRepoId ||
    data.openGitHubWorkItem ||
    data.openGitLabWorkItem ||
    data.openLinearIssue ||
    data.openJiraIssue
  )
}

/** Whether this open will most likely land on a plugin source (skips built-in prefetch). */
export function taskPageOpenPrefersPluginSource(
  data: TaskPageData,
  savedDefault: string | null | undefined
): boolean {
  if (data.pluginTaskSource) {
    return true
  }
  return !taskPageDataRequestsBuiltin(data) && parsePluginTaskSourceKey(savedDefault) !== null
}
