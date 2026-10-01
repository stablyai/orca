import {
  MAX_WORKTREE_TAGS,
  compareWorktreeTags,
  normalizeWorktreeTags,
  preferTagSpelling,
  worktreeTagKey
} from '../../../../shared/worktree/worktree-tags'

type Taggable = { id: string; tags?: readonly string[] }

export type WorkspaceTagUpdate<T extends Taggable> = { workspace: T; tags: string[] }

export type WorkspaceTagSummary = { tag: string; count: number }

function hasTag(workspace: Taggable, key: string): boolean {
  return normalizeWorktreeTags(workspace.tags).some((tag) => worktreeTagKey(tag) === key)
}

/** Every tag in use, alphabetically, with a stable spelling. Unused tags do not exist. */
export function collectWorkspaceTags(workspaces: readonly Taggable[]): WorkspaceTagSummary[] {
  const byKey = new Map<string, WorkspaceTagSummary>()
  for (const workspace of workspaces) {
    for (const tag of normalizeWorktreeTags(workspace.tags)) {
      const key = worktreeTagKey(tag)
      const summary = byKey.get(key)
      if (summary) {
        summary.count += 1
        summary.tag = preferTagSpelling(summary.tag, tag)
      } else {
        byKey.set(key, { tag, count: 1 })
      }
    }
  }
  return [...byKey.values()].sort((left, right) => compareWorktreeTags(left.tag, right.tag))
}

export type TagSelectionState = 'all' | 'some' | 'none'

export function getTagSelectionState(
  workspaces: readonly Taggable[],
  tag: string
): TagSelectionState {
  const key = worktreeTagKey(tag)
  const tagged = workspaces.filter((workspace) => hasTag(workspace, key)).length
  if (tagged === 0) {
    return 'none'
  }
  return tagged === workspaces.length ? 'all' : 'some'
}

function isAtTagLimit(workspace: Taggable): boolean {
  return normalizeWorktreeTags(workspace.tags).length >= MAX_WORKTREE_TAGS
}

/** Workspaces that lack the tag but cannot take another one. */
export function countAtTagLimit(workspaces: readonly Taggable[], tag: string): number {
  const key = worktreeTagKey(tag)
  return workspaces.filter((workspace) => !hasTag(workspace, key) && isAtTagLimit(workspace)).length
}

/** Toggle across a selection: remove when every workspace has it, otherwise add to the rest. */
export function planTagToggle<T extends Taggable>(
  workspaces: readonly T[],
  tag: string
): WorkspaceTagUpdate<T>[] {
  const key = worktreeTagKey(tag)
  if (!key) {
    return []
  }
  const remove = getTagSelectionState(workspaces, tag) === 'all'
  const updates: WorkspaceTagUpdate<T>[] = []
  for (const workspace of workspaces) {
    const current = normalizeWorktreeTags(workspace.tags)
    const present = current.some((entry) => worktreeTagKey(entry) === key)
    if (remove && present) {
      updates.push({ workspace, tags: current.filter((entry) => worktreeTagKey(entry) !== key) })
    } else if (!remove && !present && current.length < MAX_WORKTREE_TAGS) {
      updates.push({ workspace, tags: normalizeWorktreeTags([...current, tag]) })
    }
  }
  return updates
}

/** Add a tag to every workspace that lacks it; never removes (drag-and-drop onto a tag). */
export function planTagAdd<T extends Taggable>(
  workspaces: readonly T[],
  tag: string
): WorkspaceTagUpdate<T>[] {
  const key = worktreeTagKey(tag)
  if (!key) {
    return []
  }
  return workspaces
    .filter((workspace) => !hasTag(workspace, key) && !isAtTagLimit(workspace))
    .map((workspace) => ({
      workspace,
      tags: normalizeWorktreeTags([...normalizeWorktreeTags(workspace.tags), tag])
    }))
}

/** Rename everywhere; renaming onto an existing tag merges the two. */
export function planTagRename<T extends Taggable>(
  workspaces: readonly T[],
  from: string,
  to: string
): WorkspaceTagUpdate<T>[] {
  const fromKey = worktreeTagKey(from)
  const next = normalizeWorktreeTags([to])[0]
  if (!fromKey || !next) {
    return []
  }
  const updates: WorkspaceTagUpdate<T>[] = []
  for (const workspace of workspaces) {
    const current = normalizeWorktreeTags(workspace.tags)
    if (!current.some((entry) => worktreeTagKey(entry) === fromKey)) {
      continue
    }
    const tags = normalizeWorktreeTags(
      current.map((entry) => (worktreeTagKey(entry) === fromKey ? next : entry))
    )
    if (tags.join('\u0000') !== current.join('\u0000')) {
      updates.push({ workspace, tags })
    }
  }
  return updates
}

export function planTagDelete<T extends Taggable>(
  workspaces: readonly T[],
  tag: string
): WorkspaceTagUpdate<T>[] {
  const key = worktreeTagKey(tag)
  return workspaces
    .filter((workspace) => hasTag(workspace, key))
    .map((workspace) => ({
      workspace,
      tags: normalizeWorktreeTags(workspace.tags).filter((entry) => worktreeTagKey(entry) !== key)
    }))
}
