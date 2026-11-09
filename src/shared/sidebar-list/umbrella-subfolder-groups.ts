import { getRepoExecutionHostId, type ExecutionHostId } from '../execution-host'
import type { ProjectGroup } from '../project-group-types'
import type { OccurrenceSectionPath } from '../worktree-occurrence-plan'
import type { OrderedGroupEntry } from './worktree-group-entry'

export type UmbrellaComparableRepo = {
  id: string
  path: string
  connectionId?: string | null
  executionHostId?: ExecutionHostId | null
}

export type UmbrellaSubfolderHierarchy<T> = {
  rootEntries: T[]
  childrenByParentKey: Map<string, T[]>
  parentKeyByKey: Map<string, string>
  depthByKey: Map<string, number>
  orderedEntries: T[]
  isAncestorCollapsed: (key: string, collapsedKeys: ReadonlySet<string>) => boolean
}

export function getUmbrellaSubfoldersGroupKey(parentKey: string): string {
  return `umbrella-subfolders:${parentKey}`
}

export function normalizeRepoFilesystemPath(rawPath: string | null | undefined): string | null {
  if (typeof rawPath !== 'string') {
    return null
  }
  const normalized = rawPath.trim().replace(/\\/g, '/')
  if (!normalized.startsWith('/') && !/^[a-zA-Z]:\//.test(normalized)) {
    return null
  }
  if (normalized === '/' || /^[a-zA-Z]:\/$/.test(normalized)) {
    return normalized
  }
  return normalized.replace(/\/+$/, '')
}

export function isStrictSubfolderRepoPath(
  childPath: string | null | undefined,
  parentPath: string | null | undefined
): boolean {
  const childNorm = normalizeRepoFilesystemPath(childPath)
  const parentNorm = normalizeRepoFilesystemPath(parentPath)
  if (!childNorm || !parentNorm || childNorm.length <= parentNorm.length) {
    return false
  }
  const prefix = parentNorm.endsWith('/') ? parentNorm : `${parentNorm}/`
  return childNorm.startsWith(prefix)
}

export function buildUmbrellaSubfolderHierarchy<T>(
  entries: readonly T[],
  keyOf: (entry: T) => string,
  repoOf: (entry: T) => UmbrellaComparableRepo | undefined
): UmbrellaSubfolderHierarchy<T> {
  const candidates = entries.flatMap((entry) => {
    const repo = repoOf(entry)
    const normalizedPath = normalizeRepoFilesystemPath(repo?.path)
    if (!repo || !normalizedPath) {
      return []
    }
    return [
      {
        entry,
        key: keyOf(entry),
        repoId: repo.id,
        hostId: getRepoExecutionHostId(repo),
        normalizedPath
      }
    ]
  })

  const parentKeyByKey = new Map<string, string>()
  const childrenByParentKey = new Map<string, T[]>()

  for (const entry of entries) {
    const key = keyOf(entry)
    const repo = repoOf(entry)
    const childPath = normalizeRepoFilesystemPath(repo?.path)
    if (!repo || !childPath) {
      continue
    }
    const childHostId = getRepoExecutionHostId(repo)
    let bestParentKey: string | null = null
    let bestParentPathLength = -1

    for (const candidate of candidates) {
      if (
        candidate.key === key ||
        candidate.repoId === repo.id ||
        candidate.hostId !== childHostId ||
        candidate.normalizedPath.length <= bestParentPathLength
      ) {
        continue
      }
      if (isStrictSubfolderRepoPath(childPath, candidate.normalizedPath)) {
        bestParentKey = candidate.key
        bestParentPathLength = candidate.normalizedPath.length
      }
    }

    if (bestParentKey) {
      parentKeyByKey.set(key, bestParentKey)
      const siblings = childrenByParentKey.get(bestParentKey) ?? []
      siblings.push(entry)
      childrenByParentKey.set(bestParentKey, siblings)
    }
  }

  const rootEntries = entries.filter((entry) => !parentKeyByKey.has(keyOf(entry)))
  const depthByKey = new Map<string, number>()
  const orderedEntries: T[] = []
  const visited = new Set<string>()

  const visit = (entry: T, depth: number): void => {
    const key = keyOf(entry)
    if (visited.has(key)) {
      return
    }
    visited.add(key)
    depthByKey.set(key, depth)
    orderedEntries.push(entry)
    for (const child of childrenByParentKey.get(key) ?? []) {
      visit(child, depth + 1)
    }
  }

  for (const root of rootEntries) {
    visit(root, 0)
  }
  for (const entry of entries) {
    if (!visited.has(keyOf(entry))) {
      visit(entry, 0)
    }
  }

  const isAncestorCollapsed = (key: string, collapsedKeys: ReadonlySet<string>): boolean => {
    const seen = new Set<string>()
    let current = parentKeyByKey.get(key)
    while (current && !seen.has(current)) {
      if (collapsedKeys.has(current) || collapsedKeys.has(getUmbrellaSubfoldersGroupKey(current))) {
        return true
      }
      seen.add(current)
      current = parentKeyByKey.get(current)
    }
    return false
  }

  return {
    rootEntries,
    childrenByParentKey,
    parentKeyByKey,
    depthByKey,
    orderedEntries,
    isAncestorCollapsed
  }
}

export function isUmbrellaBackedProjectGroup(
  projectGroup: Pick<ProjectGroup, 'parentPath'>,
  repoEntries: readonly OrderedGroupEntry[],
  childGroupCount: number,
  folderWorkspaceCount: number
): boolean {
  if (childGroupCount > 0 || folderWorkspaceCount > 0 || repoEntries.length < 2) {
    return false
  }
  const groupPath = normalizeRepoFilesystemPath(projectGroup.parentPath)
  if (!groupPath) {
    return false
  }
  const hierarchy = buildUmbrellaSubfolderHierarchy(
    repoEntries,
    ([key]) => key,
    ([, group]) => group.repo
  )
  if (hierarchy.rootEntries.length !== 1) {
    return false
  }
  const rootRepoPath = normalizeRepoFilesystemPath(hierarchy.rootEntries[0]?.[1].repo?.path)
  return rootRepoPath === groupPath
}

export function buildUmbrellaRevealParent(
  groups: readonly OrderedGroupEntry[],
  projectGroupPaths: ReadonlyMap<string, OccurrenceSectionPath>,
  sectionKey: string,
  projectGroupId: string | null | undefined
): OccurrenceSectionPath | undefined {
  const umbrellaHierarchy = buildUmbrellaSubfolderHierarchy(
    groups,
    ([k]) => k,
    ([, g]) => g.repo
  )
  const baseParent = projectGroupId ? projectGroupPaths.get(projectGroupId) : undefined
  const ancestorKeys: string[] = []
  const seen = new Set<string>()
  let current = umbrellaHierarchy.parentKeyByKey.get(sectionKey)
  while (current && !seen.has(current)) {
    seen.add(current)
    ancestorKeys.unshift(current, getUmbrellaSubfoldersGroupKey(current))
    current = umbrellaHierarchy.parentKeyByKey.get(current)
  }
  let path = baseParent
  for (const ancestorKey of ancestorKeys) {
    path = { key: ancestorKey, parent: path }
  }
  return path
}

export type OrderedUmbrellaProjectSection<TSection extends { repo?: unknown }> = {
  key: string
  section: TSection
  decoration: {
    repo?: TSection['repo']
    isProjectGroup?: boolean
    projectGroupDepth?: number
    parentSectionKey?: string
    count?: number
  }
}

export function orderUmbrellaProjectSections<
  TSection extends { label: string; items: readonly unknown[]; repo?: UmbrellaComparableRepo }
>(
  projectSections: readonly (readonly [string, TSection])[]
): OrderedUmbrellaProjectSection<TSection>[] {
  const hierarchy = buildUmbrellaSubfolderHierarchy(
    projectSections,
    ([k]) => k,
    ([, s]) => s.repo
  )
  const out: OrderedUmbrellaProjectSection<TSection>[] = []
  const emit = (
    [key, section]: readonly [string, TSection],
    depth: number,
    parentSectionKey?: string
  ): void => {
    const children = hierarchy.childrenByParentKey.get(key) ?? []
    out.push({
      key,
      section,
      decoration: {
        repo: section.repo,
        ...(depth > 0 ? { projectGroupDepth: depth } : {}),
        ...(parentSectionKey ? { parentSectionKey } : {}),
        ...(section.items.length === 0 && children.length > 0 ? { count: children.length } : {})
      }
    })
    if (children.length > 0) {
      const subfoldersKey = getUmbrellaSubfoldersGroupKey(key)
      out.push({
        key: subfoldersKey,
        section: { ...section, label: `${section.label} / subfolders`, items: [], repo: undefined },
        decoration: {
          isProjectGroup: true,
          projectGroupDepth: depth + 1,
          parentSectionKey: key,
          count: children.length
        }
      })
      for (const child of children) {
        emit(child, depth + 2, subfoldersKey)
      }
    }
  }
  for (const root of hierarchy.rootEntries) {
    emit(root, 0)
  }
  return out
}

export function isSectionHiddenByCollapsedUmbrella(
  sections: readonly { key: string; parentSectionKey?: string }[],
  sectionKey: string,
  collapsed: ReadonlySet<string>
): boolean {
  const parentKeyBySectionKey = new Map(
    sections.flatMap((s) => (s.parentSectionKey ? [[s.key, s.parentSectionKey] as const] : []))
  )
  let cur = parentKeyBySectionKey.get(sectionKey)
  const visited = new Set<string>()
  while (cur && !visited.has(cur)) {
    visited.add(cur)
    if (collapsed.has(cur)) {
      return true
    }
    cur = parentKeyBySectionKey.get(cur)
  }
  return false
}
