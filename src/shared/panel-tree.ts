import type { PanelTreeGroup, PinnedTerminalPanel, PinnedWebPanel } from './types'

export const PANEL_TREE_ROOT_USER = 'user-panels' as const
export const PANEL_TREE_ROOT_NODES = 'nodes' as const
export type PanelTreeRootKind = typeof PANEL_TREE_ROOT_USER | typeof PANEL_TREE_ROOT_NODES

export const MAX_PANEL_TREE_GROUPS = 48
export const MAX_PANEL_TREE_DEPTH = 3
const MAX_GROUP_TITLE = 60

export function normalizePanelTreeGroups(value: unknown): PanelTreeGroup[] {
  if (!Array.isArray(value)) {
    return []
  }
  const groups: PanelTreeGroup[] = []
  const seen = new Set<string>()
  for (const entry of value) {
    if (groups.length >= MAX_PANEL_TREE_GROUPS) {
      break
    }
    if (typeof entry !== 'object' || entry === null) {
      continue
    }
    const row = entry as Record<string, unknown>
    if (typeof row.id !== 'string' || row.id.length === 0 || seen.has(row.id)) {
      continue
    }
    if (row.root !== PANEL_TREE_ROOT_USER && row.root !== PANEL_TREE_ROOT_NODES) {
      continue
    }
    const title = typeof row.title === 'string' ? row.title.trim().slice(0, MAX_GROUP_TITLE) : ''
    if (title.length === 0) {
      continue
    }
    const parentId =
      row.parentId === null
        ? null
        : typeof row.parentId === 'string' && row.parentId.length > 0
          ? row.parentId
          : null
    const order =
      typeof row.order === 'number' && Number.isFinite(row.order) ? row.order : groups.length
    seen.add(row.id)
    groups.push({
      id: row.id,
      title,
      root: row.root,
      parentId,
      order,
      ...(row.collapsed === true ? { collapsed: true } : {})
    })
  }
  // Drop parent pointers that don't exist (corrupted profiles).
  const ids = new Set(groups.map((g) => g.id))
  return groups
    .map((g) => (g.parentId !== null && !ids.has(g.parentId) ? { ...g, parentId: null } : g))
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

/** Depth of a group under its root (0 = top-level family). */
export function panelTreeGroupDepth(groups: readonly PanelTreeGroup[], groupId: string): number {
  const byId = new Map(groups.map((g) => [g.id, g]))
  let depth = 0
  let current = byId.get(groupId)
  const guard = new Set<string>()
  while (current?.parentId) {
    if (guard.has(current.id)) {
      return MAX_PANEL_TREE_DEPTH + 1
    }
    guard.add(current.id)
    depth += 1
    current = byId.get(current.parentId)
    if (depth > MAX_PANEL_TREE_DEPTH) {
      return depth
    }
  }
  return depth
}

/** Titles from the outermost group down to `groupId` ("node-a", "gpu"), for
 *  UI that shows where a panel lives (search subtitles, tooltips). Unknown or
 *  cyclic ids yield an empty path rather than throwing. */
export function panelTreeGroupPath(
  groups: readonly PanelTreeGroup[],
  groupId: string | null | undefined
): string[] {
  if (!groupId) {
    return []
  }
  const byId = new Map(groups.map((g) => [g.id, g]))
  const path: string[] = []
  const guard = new Set<string>()
  let current = byId.get(groupId)
  while (current) {
    if (guard.has(current.id)) {
      return []
    }
    guard.add(current.id)
    path.unshift(current.title)
    if (path.length > MAX_PANEL_TREE_DEPTH + 1) {
      break
    }
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path
}

export function canReparentPanelTreeGroup(
  groups: readonly PanelTreeGroup[],
  groupId: string,
  newParentId: string | null
): boolean {
  if (newParentId === null) {
    return true
  }
  if (newParentId === groupId) {
    return false
  }
  const byId = new Map(groups.map((g) => [g.id, g]))
  const moving = byId.get(groupId)
  const parent = byId.get(newParentId)
  if (!moving || !parent || moving.root !== parent.root) {
    return false
  }
  // Cycle: new parent cannot be under moving.
  let walk: PanelTreeGroup | undefined = parent
  const guard = new Set<string>()
  while (walk) {
    if (walk.id === groupId) {
      return false
    }
    if (guard.has(walk.id)) {
      return false
    }
    guard.add(walk.id)
    walk = walk.parentId ? byId.get(walk.parentId) : undefined
  }
  // Depth after move: parent depth + 1 must be < MAX
  return panelTreeGroupDepth(groups, newParentId) + 1 < MAX_PANEL_TREE_DEPTH
}

/**
 * Ensure every legacy terminal `group` string has a matching nodes root group,
 * and assign groupId on panels. Web panels stay ungrouped unless they already
 * carry groupId. Returns next groups + next terminal panels (web unchanged).
 */
export function migrateLegacyPanelGroups(input: {
  groups: readonly PanelTreeGroup[]
  terminalPanels: readonly PinnedTerminalPanel[]
  webPanels: readonly PinnedWebPanel[]
}): {
  groups: PanelTreeGroup[]
  terminalPanels: PinnedTerminalPanel[]
  webPanels: PinnedWebPanel[]
} {
  const groups = [...input.groups]
  const byRootTitle = new Map<string, PanelTreeGroup>()
  for (const g of groups) {
    if (g.parentId === null) {
      byRootTitle.set(`${g.root}::${g.title}`, g)
    }
  }

  const ensureGroup = (root: PanelTreeRootKind, title: string): PanelTreeGroup => {
    const key = `${root}::${title}`
    const existing = byRootTitle.get(key)
    if (existing) {
      return existing
    }
    const created: PanelTreeGroup = {
      id: crypto.randomUUID(),
      title,
      root,
      parentId: null,
      order: groups.filter((g) => g.root === root && g.parentId === null).length
    }
    groups.push(created)
    byRootTitle.set(key, created)
    return created
  }

  const terminalPanels = input.terminalPanels.map((panel, index) => {
    if (panel.groupId && groups.some((g) => g.id === panel.groupId)) {
      return { ...panel, order: panel.order ?? index }
    }
    const label = panel.group?.trim()
    if (!label) {
      return { ...panel, groupId: undefined, order: panel.order ?? index }
    }
    const group = ensureGroup(PANEL_TREE_ROOT_NODES, label)
    return {
      ...panel,
      groupId: group.id,
      // Keep legacy string for one-release readers; sidebar prefers groupId.
      group: label,
      order: panel.order ?? index
    }
  })

  const webPanels = input.webPanels.map((panel, index) => {
    if (panel.groupId && groups.some((g) => g.id === panel.groupId)) {
      return { ...panel, order: panel.order ?? index }
    }
    return { ...panel, groupId: undefined, order: panel.order ?? index }
  })

  return {
    groups: normalizePanelTreeGroups(groups),
    terminalPanels,
    webPanels
  }
}

export function childrenOfGroup(
  groups: readonly PanelTreeGroup[],
  root: PanelTreeRootKind,
  parentId: string | null
): PanelTreeGroup[] {
  return groups
    .filter((g) => g.root === root && g.parentId === parentId)
    .sort((a, b) => a.order - b.order || a.title.localeCompare(b.title))
}

export function panelsInGroup<T extends { groupId?: string | null; order?: number }>(
  panels: readonly T[],
  groupId: string | null
): T[] {
  return panels
    .filter((p) => (p.groupId ?? null) === groupId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}

/** Reorder panels within the same group; optional group change for the moved panel. */
export function movePanelInTree<T extends { id: string; groupId?: string | null; order?: number }>(
  panels: readonly T[],
  draggedId: string,
  overId: string,
  nextGroupId: string | null
): T[] {
  const from = panels.findIndex((p) => p.id === draggedId)
  if (from < 0) {
    return [...panels]
  }
  const moved = { ...panels[from], groupId: nextGroupId ?? undefined }
  const without = panels.filter((p) => p.id !== draggedId)
  const overIndex = without.findIndex((p) => p.id === overId)
  const insertAt = overIndex < 0 ? without.length : overIndex
  const next = [...without]
  next.splice(insertAt, 0, moved)
  // Reassign order within each group bucket for stable persistence.
  const orderByGroup = new Map<string | null, number>()
  return next.map((panel) => {
    const gid = panel.groupId ?? null
    const order = orderByGroup.get(gid) ?? 0
    orderByGroup.set(gid, order + 1)
    return { ...panel, order }
  })
}

export function renamePanelTreeGroup(
  groups: readonly PanelTreeGroup[],
  groupId: string,
  title: string
): PanelTreeGroup[] {
  const trimmed = title.trim().slice(0, MAX_GROUP_TITLE)
  if (trimmed.length === 0) {
    return [...groups]
  }
  return groups.map((g) => (g.id === groupId ? { ...g, title: trimmed } : g))
}

export function createPanelTreeGroup(input: {
  groups: readonly PanelTreeGroup[]
  root: PanelTreeRootKind
  title: string
  parentId?: string | null
}): PanelTreeGroup[] {
  const parentId = input.parentId ?? null
  if (parentId !== null) {
    const parent = input.groups.find((g) => g.id === parentId)
    if (!parent || parent.root !== input.root) {
      return [...input.groups]
    }
    if (panelTreeGroupDepth(input.groups, parentId) + 1 >= MAX_PANEL_TREE_DEPTH) {
      return [...input.groups]
    }
  }
  const title = input.title.trim().slice(0, MAX_GROUP_TITLE) || 'New group'
  const siblings = childrenOfGroup(input.groups, input.root, parentId)
  const created: PanelTreeGroup = {
    id: crypto.randomUUID(),
    title,
    root: input.root,
    parentId,
    order: siblings.length
  }
  return normalizePanelTreeGroups([...input.groups, created])
}

/** Delete group: children groups reparent to parent; panels move to parent group. */
export function deletePanelTreeGroup<
  Term extends { groupId?: string | null },
  Web extends { groupId?: string | null }
>(input: {
  groups: readonly PanelTreeGroup[]
  groupId: string
  terminalPanels: readonly Term[]
  webPanels: readonly Web[]
}): { groups: PanelTreeGroup[]; terminalPanels: Term[]; webPanels: Web[] } {
  const victim = input.groups.find((g) => g.id === input.groupId)
  if (!victim) {
    return {
      groups: [...input.groups],
      terminalPanels: [...input.terminalPanels],
      webPanels: [...input.webPanels]
    }
  }
  const parentId = victim.parentId
  const groups = input.groups
    .filter((g) => g.id !== victim.id)
    .map((g) => (g.parentId === victim.id ? { ...g, parentId } : g))
  const rehome = <U extends { groupId?: string | null }>(panels: readonly U[]): U[] =>
    panels.map((p) => (p.groupId === victim.id ? { ...p, groupId: parentId ?? undefined } : p))
  return {
    groups: normalizePanelTreeGroups(groups),
    terminalPanels: rehome(input.terminalPanels),
    webPanels: rehome(input.webPanels)
  }
}
