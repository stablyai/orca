import { resolveClaudeHomeBindingForGroup } from '../../../../shared/claude-home-binding'
import {
  getProjectGroupExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../shared/project-group-types'

export type InheritedClaudeConfigDir = {
  configDir: string
  groupId: string
  groupName: string
}

/**
 * Why host-scoped: the sidebar lists groups from every execution host at once, so the same id can
 * appear twice and a config dir is a filesystem path on exactly one host. An unstamped legacy row
 * is the only fallback; a row stamped for a different host never answers.
 */
export function selectProjectGroupForHost(
  groups: readonly ProjectGroup[],
  groupId: string,
  executionHostId?: ExecutionHostId | null
): ProjectGroup | null {
  let unstamped: ProjectGroup | null = null
  for (const group of groups) {
    if (group.id !== groupId) {
      continue
    }
    if (executionHostId && getProjectGroupExecutionHostId(group) === executionHostId) {
      return group
    }
    if (!group.executionHostId && !group.connectionId) {
      unstamped ??= group
    }
  }
  return unstamped
}

/**
 * The binding this group would run under if it had none of its own, plus the ancestor that
 * supplies it. Null when the group is bound itself or nothing up the tree is bound.
 */
export function selectInheritedClaudeConfigDir(
  groups: readonly ProjectGroup[],
  groupId: string,
  executionHostId?: ExecutionHostId | null
): InheritedClaudeConfigDir | null {
  const resolved = resolveClaudeHomeBindingForGroup(groups, groupId, executionHostId)
  if (!resolved || resolved.groupId === groupId) {
    return null
  }
  const supplier = selectProjectGroupForHost(groups, resolved.groupId, executionHostId)
  return {
    configDir: resolved.configDir,
    groupId: resolved.groupId,
    groupName: supplier?.name ?? resolved.groupId
  }
}
