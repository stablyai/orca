import type {
  RuntimeGitLocalBranches,
  RuntimeRepoSearchRefs
} from '../../../../../../shared/runtime-worktree-contracts'
import type { BranchSwitchTarget } from '../../../../../../shared/git/branch-switch-target'
import { isBranchNameValid } from '../../../../../../shared/git/branch-switch-target'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'

export const LOCAL_BRANCH_WINDOW = 50
export const BRANCH_PICKER_ROW_LIMIT = 100

export type BranchWorkspace = { id: string; path: string; repoId: string; hostId?: ExecutionHostId }
export type BranchPickerRow = {
  target: BranchSwitchTarget
  label: string
  current?: boolean
  committedAt?: number
  occupiedPath?: string
  workspace?: BranchWorkspace
}
export function indexBranchWorkspaces(
  open: boolean,
  workspaces: Iterable<BranchWorkspace>,
  repoId: string,
  hostId: ExecutionHostId
): Map<string, BranchWorkspace> | null {
  if (!open) {
    return null
  }
  const map = new Map<string, BranchWorkspace>()
  for (const workspace of workspaces) {
    if (workspace.repoId === repoId && (workspace.hostId ?? 'local') === hostId) {
      map.set(normalizeRuntimePathForComparison(workspace.path), workspace)
    }
  }
  return map
}
export function indexLocalBranchRows(
  local: RuntimeGitLocalBranches,
  currentPath: string,
  workspaces: Map<string, BranchWorkspace> | null
): BranchPickerRow[] {
  const normalizedCurrent = normalizeRuntimePathForComparison(currentPath)
  return local.branches
    .map<BranchPickerRow>((name) => {
      const path =
        local.worktreePaths && Object.hasOwn(local.worktreePaths, name)
          ? local.worktreePaths[name]
          : undefined
      const occupiedPath =
        path && normalizeRuntimePathForComparison(path) !== normalizedCurrent ? path : undefined
      return {
        target: { kind: 'local', name },
        label: name,
        current: name === local.current,
        committedAt:
          local.committedAt && Object.hasOwn(local.committedAt, name)
            ? local.committedAt[name]
            : undefined,
        occupiedPath,
        workspace: occupiedPath
          ? workspaces?.get(normalizeRuntimePathForComparison(occupiedPath))
          : undefined
      }
    })
    .sort(
      (a, b) =>
        Number(Boolean(b.current)) - Number(Boolean(a.current)) ||
        (b.committedAt ?? 0) - (a.committedAt ?? 0)
    )
}
export function branchPickerRows(
  localRows: BranchPickerRow[],
  localNames: Set<string>,
  remote: RuntimeRepoSearchRefs | null,
  query: string
): BranchPickerRow[] {
  const name = query.trim()
  const normalized = name.toLowerCase()
  const current: BranchPickerRow[] = []
  const exact: BranchPickerRow[] = []
  const prefix: BranchPickerRow[] = []
  const rest: BranchPickerRow[] = []
  for (const row of localRows) {
    const label = row.label.toLowerCase()
    if (row.current) {
      current.push(row)
    } else if (row.label === name) {
      exact.push(row)
    } else if (label.startsWith(normalized)) {
      prefix.push(row)
    } else if (label.includes(normalized)) {
      rest.push(row)
    }
  }
  const rows = [...current, ...exact, ...prefix, ...rest].slice(0, LOCAL_BRANCH_WINDOW)
  const remoteRows = remote?.refDetails ?? []
  const canCreate =
    isBranchNameValid(name) &&
    !localNames.has(name) &&
    !remoteRows.some((ref) => ref.localBranchName === name || ref.refName === name)
  for (const ref of remoteRows) {
    if (ref.refName.startsWith('refs/heads/') || localNames.has(ref.localBranchName)) {
      continue
    }
    if (rows.length >= BRANCH_PICKER_ROW_LIMIT - Number(canCreate)) {
      break
    }
    rows.push({
      target: { kind: 'remote', name: ref.refName.replace(/^refs\/remotes\//, '') },
      label: ref.refName.replace(/^refs\/remotes\//, '')
    })
  }
  if (canCreate) {
    rows.push({ target: { kind: 'new', name }, label: name })
  }
  return rows
}
