import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { AppState } from '@/store'

type RoutingState = Pick<
  AppState,
  'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'
>
function sameRows<T>(
  left: readonly T[],
  right: readonly T[],
  fields: readonly (keyof T)[]
): boolean {
  return (
    left === right ||
    (left.length === right.length &&
      left.every(
        (row, i) => row === right[i] || fields.every((field) => row[field] === right[i][field])
      ))
  )
}
export function haveSameTerminalRoutingInputs(left: RoutingState, right: RoutingState): boolean {
  if (
    !sameRows(selectFolderWorkspaces(left), selectFolderWorkspaces(right), [
      'id',
      'folderPath',
      'projectGroupId',
      'connectionId',
      'executionHostId'
    ]) ||
    !sameRows(left.projectGroups, right.projectGroups, [
      'id',
      'parentGroupId',
      'connectionId',
      'executionHostId'
    ]) ||
    !sameRows(left.repos, right.repos, [
      'id',
      'path',
      'projectGroupId',
      'connectionId',
      'executionHostId'
    ])
  ) {
    return false
  }
  const leftWorktrees = selectWorktreesByRepo(left)
  const rightWorktrees = selectWorktreesByRepo(right)
  if (leftWorktrees === rightWorktrees) {
    return true
  }
  const keys = Object.keys(leftWorktrees)
  const oldKeys = Object.keys(rightWorktrees)
  return (
    keys.length === oldKeys.length &&
    keys.every(
      (key, i) =>
        key === oldKeys[i] &&
        sameRows(leftWorktrees[key], rightWorktrees[key], ['id', 'hostId', 'repoId'])
    )
  )
}
