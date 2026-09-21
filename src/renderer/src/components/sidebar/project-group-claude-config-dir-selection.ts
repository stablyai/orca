import {
  findRowForHost,
  resolveClaudeHomeBindingForGroup
} from '../../../../shared/claude-home-binding'
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
  return (
    findRowForHost(
      groups,
      (group) => group.id === groupId,
      getProjectGroupExecutionHostId,
      executionHostId
    ) ?? null
  )
}

/**
 * The binding this group would run under if it had none of its own, plus the ancestor that
 * supplies it. Null when nothing up the tree is bound.
 *
 * Why the walk starts at the parent: a bound group still has an ancestor to fall back to, and
 * clearing the field must be able to name it. Starting at the group itself answers with the
 * group's own binding and hides the ancestor for exactly those groups.
 */
export function selectInheritedClaudeConfigDir(
  groups: readonly ProjectGroup[],
  groupId: string,
  executionHostId?: ExecutionHostId | null
): InheritedClaudeConfigDir | null {
  const group = selectProjectGroupForHost(groups, groupId, executionHostId)
  const resolved = resolveClaudeHomeBindingForGroup(groups, group?.parentGroupId, executionHostId)
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
