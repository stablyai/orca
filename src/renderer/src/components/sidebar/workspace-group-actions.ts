import type {
  WorkspaceGroup,
  WorkspaceGroupColor,
  WorkspaceGroupId
} from '../../../../shared/types'
import {
  WORKSPACE_GROUP_COLOR_IDS,
  DEFAULT_WORKSPACE_GROUP_COLOR,
  FALLBACK_GROUP_NAME,
  createWorkspaceGroup
} from '../../../../shared/workspace-groups'

export type MetaAssignment = {
  worktreeId: string
  workspaceGroupId: WorkspaceGroupId | null
}

export function buildNewGroupFromCreate(args: {
  existing: WorkspaceGroup[]
  name: string
  autoColor: WorkspaceGroupColor
}): { groups: WorkspaceGroup[]; newGroup: WorkspaceGroup } {
  const maxSortOrder = args.existing.reduce(
    (max, grp) => (grp.sortOrder > max ? grp.sortOrder : max),
    -1
  )
  const newGroup = createWorkspaceGroup({
    name: args.name,
    color: args.autoColor,
    sortOrder: maxSortOrder + 1
  })
  return { groups: [...args.existing, newGroup], newGroup }
}

export function buildAssignToGroupChanges(args: {
  worktreeIds: readonly string[]
  targetGroupId: WorkspaceGroupId
}): MetaAssignment[] {
  return args.worktreeIds.map((id) => ({
    worktreeId: id,
    workspaceGroupId: args.targetGroupId
  }))
}

export function buildRemoveFromGroupChanges(worktreeId: string): MetaAssignment[] {
  return [{ worktreeId, workspaceGroupId: null }]
}

export function buildUngroupChanges(args: {
  existing: WorkspaceGroup[]
  groupId: WorkspaceGroupId
  memberWorktreeIds: readonly string[]
}): { groups: WorkspaceGroup[]; updates: MetaAssignment[] } {
  return {
    groups: args.existing.filter((grp) => grp.id !== args.groupId),
    updates: args.memberWorktreeIds.map((id) => ({
      worktreeId: id,
      workspaceGroupId: null
    }))
  }
}

export function buildRenameGroup(args: {
  existing: WorkspaceGroup[]
  groupId: WorkspaceGroupId
  name: string
}): WorkspaceGroup[] {
  const trimmed = args.name.trim().replace(/\s+/g, ' ')
  const finalName = trimmed ? trimmed.slice(0, 64) : FALLBACK_GROUP_NAME
  return args.existing.map((grp) => (grp.id === args.groupId ? { ...grp, name: finalName } : grp))
}

export function buildRecolorGroup(args: {
  existing: WorkspaceGroup[]
  groupId: WorkspaceGroupId
  color: WorkspaceGroupColor
}): WorkspaceGroup[] {
  const finalColor = (WORKSPACE_GROUP_COLOR_IDS as readonly string[]).includes(args.color)
    ? args.color
    : DEFAULT_WORKSPACE_GROUP_COLOR
  return args.existing.map((grp) =>
    grp.id === args.groupId ? { ...grp, color: finalColor as WorkspaceGroupColor } : grp
  )
}

export function buildReorderHeaders(args: {
  existing: WorkspaceGroup[]
  orderedIds: readonly WorkspaceGroupId[]
}): WorkspaceGroup[] {
  const STEP = 1000
  const positionById = new Map<string, number>()
  args.orderedIds.forEach((id, idx) => positionById.set(id, idx * STEP))
  return args.existing.map((grp) => {
    const pos = positionById.get(grp.id)
    return pos === undefined ? grp : { ...grp, sortOrder: pos }
  })
}

type GroupMemberLookup = {
  id: string
  workspaceGroupId?: WorkspaceGroupId | null
}

export function expandWorktreeIdsToGroupMembers(
  worktreeIds: readonly string[],
  allWorktrees: readonly GroupMemberLookup[]
): string[] {
  const byGroup = new Map<WorkspaceGroupId, string[]>()
  for (const w of allWorktrees) {
    if (!w.workspaceGroupId) {
      continue
    }
    const arr = byGroup.get(w.workspaceGroupId) ?? []
    arr.push(w.id)
    byGroup.set(w.workspaceGroupId, arr)
  }
  const idToGroup = new Map<string, WorkspaceGroupId>()
  for (const w of allWorktrees) {
    if (w.workspaceGroupId) {
      idToGroup.set(w.id, w.workspaceGroupId)
    }
  }
  const result = new Set<string>()
  for (const id of worktreeIds) {
    result.add(id)
    const groupId = idToGroup.get(id)
    if (!groupId) {
      continue
    }
    for (const memberId of byGroup.get(groupId) ?? []) {
      result.add(memberId)
    }
  }
  return [...result]
}
