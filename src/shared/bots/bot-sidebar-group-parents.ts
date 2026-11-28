/** Sidebar-only parent links between host-qualified group keys. */
export type BotSidebarGroupParents = Readonly<Record<string, string>>

export function normalizeBotSidebarGroupParents(value: unknown): BotSidebarGroupParents {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const parents = new Map<string, string>()
  for (const [key, parent] of Object.entries(value)) {
    if (key.includes('/') && typeof parent === 'string' && parent.includes('/')) {
      parents.set(key, parent)
    }
  }
  const resolved = new Set<string>()
  for (const key of parents.keys()) {
    const path = new Set<string>()
    let current: string | undefined = key
    while (current && !resolved.has(current)) {
      path.add(current)
      const parent: string | undefined = parents.get(current)
      if (parent && path.has(parent)) {
        parents.delete(current)
        break
      }
      current = parent
    }
    for (const visited of path) {
      resolved.add(visited)
    }
  }
  return Object.fromEntries(parents)
}

export function getBotSidebarGroupPath(
  parents: BotSidebarGroupParents,
  groupKey: string
): string[] {
  const path = new Set<string>()
  for (let cursor = groupKey; cursor && !path.has(cursor); cursor = parents[cursor]) {
    path.add(cursor)
  }
  return [...path]
}

export function moveBotSidebarGroup(
  parents: BotSidebarGroupParents,
  groupKey: string,
  parentKey: string | null
): BotSidebarGroupParents {
  if (parentKey === (parents[groupKey] ?? null)) {
    return parents
  }
  if (parentKey && getBotSidebarGroupPath(parents, parentKey).includes(groupKey)) {
    return parents
  }
  const next = { ...parents }
  if (parentKey === null) {
    delete next[groupKey]
  } else {
    next[groupKey] = parentKey
  }
  return next
}

export function removeBotSidebarGroup(
  parents: BotSidebarGroupParents,
  groupKey: string
): BotSidebarGroupParents {
  const parentKey = parents[groupKey]
  if (!parentKey && !Object.values(parents).includes(groupKey)) {
    return parents
  }
  const next = { ...parents }
  delete next[groupKey]
  for (const [key, current] of Object.entries(parents)) {
    if (current === groupKey) {
      if (parentKey) {
        next[key] = parentKey
      } else {
        delete next[key]
      }
    }
  }
  return next
}

export function getBotSidebarGroupFoldKey(groupKey: string): string {
  return `bot-group:${groupKey}`
}
