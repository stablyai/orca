import { AGENT_MAP_WORKTREE_GAP, packAgentMapWorktrees } from './agent-map-worktree-packing'

const LINEAGE_VERTICAL_GAP = 28
const MAX_HIERARCHICAL_CLUSTER_FANOUT = 12
const MAX_EXACT_LINEAGE_WORKTREES = 256

type LineageWorktree = {
  id: string
  parentId?: string
  clusterParentId?: string
  x: number
  y: number
  radius: number
}

type WorktreeFamily<T extends LineageWorktree> = {
  id: string
  x: number
  y: number
  radius: number
  worktrees: T[]
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function encloseFamily<T extends LineageWorktree>(id: string, worktrees: T[]): WorktreeFamily<T> {
  const left = Math.min(...worktrees.map((worktree) => worktree.x - worktree.radius))
  const right = Math.max(...worktrees.map((worktree) => worktree.x + worktree.radius))
  const top = Math.min(...worktrees.map((worktree) => worktree.y - worktree.radius))
  const bottom = Math.max(...worktrees.map((worktree) => worktree.y + worktree.radius))
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2
  for (const worktree of worktrees) {
    worktree.x -= centerX
    worktree.y -= centerY
  }
  return {
    id,
    x: 0,
    y: 0,
    radius: Math.max(
      ...worktrees.map((worktree) => Math.hypot(worktree.x, worktree.y) + worktree.radius)
    ),
    worktrees
  }
}

function buildFamily<T extends LineageWorktree>(
  root: T,
  childrenByParent: ReadonlyMap<string, T[]>,
  emitted: Set<string>,
  ancestors: ReadonlySet<string>
): WorktreeFamily<T> {
  emitted.add(root.id)
  const nextAncestors = new Set(ancestors)
  nextAncestors.add(root.id)
  const children = (childrenByParent.get(root.id) ?? []).filter(
    (child) => !nextAncestors.has(child.id) && !emitted.has(child.id)
  )
  if (children.length === 0) {
    return {
      id: root.id,
      x: 0,
      y: 0,
      radius: root.radius,
      worktrees: [{ ...root, x: 0, y: 0 }]
    }
  }

  const childFamilies = packAgentMapWorktrees(
    children.map((child) => buildExactFamily(child, childrenByParent, emitted))
  )
  const childLeft = Math.min(...childFamilies.map((family) => family.x - family.radius))
  const childRight = Math.max(...childFamilies.map((family) => family.x + family.radius))
  const childTop = Math.min(...childFamilies.map((family) => family.y - family.radius))
  const childOffsetX = -(childLeft + childRight) / 2
  const childOffsetY = root.radius + LINEAGE_VERTICAL_GAP - childTop
  const worktrees = [{ ...root, x: 0, y: 0 }]
  for (const family of childFamilies) {
    for (const worktree of family.worktrees) {
      worktrees.push({
        ...worktree,
        x: worktree.x + family.x + childOffsetX,
        y: worktree.y + family.y + childOffsetY
      })
    }
  }
  return encloseFamily(root.id, worktrees)
}

function collectLinearFamily<T extends LineageWorktree>(
  root: T,
  childrenByParent: ReadonlyMap<string, T[]>,
  emitted: ReadonlySet<string>
): T[] | null {
  const worktrees: T[] = []
  const ancestors = new Set<string>()
  let current: T | undefined = root
  while (current) {
    worktrees.push(current)
    ancestors.add(current.id)
    const children = (childrenByParent.get(current.id) ?? []).filter(
      (child) => !ancestors.has(child.id) && !emitted.has(child.id)
    )
    if (children.length > 1) {
      return null
    }
    current = children[0]
  }
  return worktrees
}

function buildLinearFamily<T extends LineageWorktree>(worktrees: T[]): WorktreeFamily<T> {
  const positioned = worktrees.map((worktree) => ({ ...worktree, x: 0, y: 0 }))
  let radius = worktrees.at(-1)?.radius ?? 0
  for (let index = worktrees.length - 2; index >= 0; index -= 1) {
    positioned[index].y = -(radius + LINEAGE_VERTICAL_GAP / 2)
    radius += worktrees[index].radius + LINEAGE_VERTICAL_GAP / 2
  }
  let familyCenterY = 0
  for (let index = 0; index < positioned.length; index += 1) {
    positioned[index].y += familyCenterY
    familyCenterY += worktrees[index].radius + LINEAGE_VERTICAL_GAP / 2
  }
  return { id: worktrees[0].id, x: 0, y: 0, radius, worktrees: positioned }
}

function buildExactFamily<T extends LineageWorktree>(
  root: T,
  childrenByParent: ReadonlyMap<string, T[]>,
  emitted: Set<string>
): WorktreeFamily<T> {
  const linearFamily = collectLinearFamily(root, childrenByParent, emitted)
  if (!linearFamily) {
    return buildFamily(root, childrenByParent, emitted, new Set())
  }
  for (const worktree of linearFamily) {
    emitted.add(worktree.id)
  }
  return buildLinearFamily(linearFamily)
}

function layoutBoundedLineage<T extends LineageWorktree>(
  sorted: T[],
  childrenByParent: ReadonlyMap<string, T[]>,
  childIds: ReadonlySet<string>
): T[] {
  const levels: T[][] = []
  const emitted = new Set<string>()
  const roots = sorted.filter((worktree) => !childIds.has(worktree.id))

  for (const seed of [...roots, ...sorted]) {
    if (emitted.has(seed.id)) {
      continue
    }
    const stack = [{ depth: 0, worktree: seed }]
    while (stack.length > 0) {
      const entry = stack.pop()!
      if (emitted.has(entry.worktree.id)) {
        continue
      }
      emitted.add(entry.worktree.id)
      const level = levels[entry.depth] ?? []
      levels[entry.depth] = level
      level.push(entry.worktree)
      const children = childrenByParent.get(entry.worktree.id) ?? []
      for (let index = children.length - 1; index >= 0; index -= 1) {
        if (!emitted.has(children[index].id)) {
          stack.push({ depth: entry.depth + 1, worktree: children[index] })
        }
      }
    }
  }

  const positioned: T[] = []
  let y = 0
  let previousMaxRadius = 0
  let hasPositionedRow = false
  for (const level of levels) {
    const columns = Math.ceil(Math.sqrt(level.length))
    for (let rowStart = 0; rowStart < level.length; rowStart += columns) {
      const row = level.slice(rowStart, rowStart + columns)
      let maxRadius = 0
      let width = -AGENT_MAP_WORKTREE_GAP
      for (const worktree of row) {
        maxRadius = Math.max(maxRadius, worktree.radius)
        width += worktree.radius * 2 + AGENT_MAP_WORKTREE_GAP
      }
      if (hasPositionedRow) {
        y += previousMaxRadius + maxRadius + LINEAGE_VERTICAL_GAP
      }
      let x = -width / 2
      for (const worktree of row) {
        positioned.push({ ...worktree, x: x + worktree.radius, y })
        x += worktree.radius * 2 + AGENT_MAP_WORKTREE_GAP
      }
      previousMaxRadius = maxRadius
      hasPositionedRow = true
    }
  }

  let left = Number.POSITIVE_INFINITY
  let right = Number.NEGATIVE_INFINITY
  let top = Number.POSITIVE_INFINITY
  let bottom = Number.NEGATIVE_INFINITY
  for (const worktree of positioned) {
    left = Math.min(left, worktree.x - worktree.radius)
    right = Math.max(right, worktree.x + worktree.radius)
    top = Math.min(top, worktree.y - worktree.radius)
    bottom = Math.max(bottom, worktree.y + worktree.radius)
  }
  const centerX = (left + right) / 2
  const centerY = (top + bottom) / 2
  return positioned
    .map((worktree) => ({ ...worktree, x: worktree.x - centerX, y: worktree.y - centerY }))
    .sort((a, b) => compareStable(a.id, b.id))
}

export function layoutAgentMapWorktreeLineage<T extends LineageWorktree>(worktrees: T[]): T[] {
  const sorted = [...worktrees].sort((a, b) => compareStable(a.id, b.id))
  const worktreesById = new Map(sorted.map((worktree) => [worktree.id, worktree]))
  const clusterChildCounts = new Map<string, number>()
  for (const worktree of sorted) {
    if (worktree.clusterParentId && worktreesById.has(worktree.clusterParentId)) {
      clusterChildCounts.set(
        worktree.clusterParentId,
        (clusterChildCounts.get(worktree.clusterParentId) ?? 0) + 1
      )
    }
  }
  const childrenByParent = new Map<string, T[]>()
  const childIds = new Set<string>()
  for (const worktree of sorted) {
    const clusterParentId = worktree.clusterParentId
    const parentId =
      clusterParentId &&
      (clusterChildCounts.get(clusterParentId) ?? 0) <= MAX_HIERARCHICAL_CLUSTER_FANOUT
        ? clusterParentId
        : worktree.parentId
    if (!parentId || parentId === worktree.id || !worktreesById.has(parentId)) {
      continue
    }
    childIds.add(worktree.id)
    const siblings = childrenByParent.get(parentId)
    if (siblings) {
      siblings.push(worktree)
    } else {
      childrenByParent.set(parentId, [worktree])
    }
  }
  if (sorted.length > MAX_EXACT_LINEAGE_WORKTREES) {
    return layoutBoundedLineage(sorted, childrenByParent, childIds)
  }

  const emitted = new Set<string>()
  const families: WorktreeFamily<T>[] = []
  for (const root of sorted.filter((worktree) => !childIds.has(worktree.id))) {
    if (!emitted.has(root.id)) {
      families.push(buildExactFamily(root, childrenByParent, emitted))
    }
  }
  for (const worktree of sorted) {
    if (!emitted.has(worktree.id)) {
      families.push(buildExactFamily(worktree, childrenByParent, emitted))
    }
  }

  return packAgentMapWorktrees(families)
    .flatMap((family) =>
      family.worktrees.map((worktree) => ({
        ...worktree,
        x: worktree.x + family.x,
        y: worktree.y + family.y
      }))
    )
    .sort((a, b) => compareStable(a.id, b.id))
}
