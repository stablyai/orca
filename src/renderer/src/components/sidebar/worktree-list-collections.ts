import { Layers } from 'lucide-react'
import { sortCollectionsByOrder } from '../../../../shared/collections'
import type { Collection } from '../../../../shared/collection-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { PINNED_GROUP_KEY } from './worktree-list/grouping/group-keys'
import type { Row } from './worktree-list/grouping/row-types'

export const COLLECTION_GROUP_META = {
  tone: 'text-foreground',
  icon: Layers
} as const

export function getCollectionHeaderKey(collectionId: string): string {
  return `collection:${collectionId}`
}

export function getCollectionRepoHeaderKey(collectionId: string, repoId: string): string {
  return `collection:${collectionId}:repo:${repoId}`
}

/** Collection rows are visual duplicates of project-list rows; reorder and
 *  preference machinery must skip them. */
export function isCollectionSectionKey(sectionKey: string | undefined): boolean {
  return sectionKey?.startsWith('collection:') === true
}

/** Pinned stays the topmost sidebar section; collection sections slot between
 *  it and the untouched project list. */
export function insertCollectionRowsAfterPinned(
  builtRows: readonly Row[],
  collectionRows: readonly Row[]
): Row[] {
  if (collectionRows.length === 0) {
    return [...builtRows]
  }
  let pinnedEnd = 0
  const first = builtRows[0]
  if (first?.type === 'header' && first.key === PINNED_GROUP_KEY) {
    pinnedEnd = 1
    while (pinnedEnd < builtRows.length && builtRows[pinnedEnd].type !== 'header') {
      pinnedEnd++
    }
  }
  return [...builtRows.slice(0, pinnedEnd), ...collectionRows, ...builtRows.slice(pinnedEnd)]
}

/** Additive sidebar sections: one block per collection, its member worktrees
 *  grouped under repo sub-headers. Rows are namespaced per collection because
 *  the same worktree may render in several collections and in the normal
 *  project list below (many-to-many membership, purely visual). */
export function buildCollectionRows(input: {
  collections: readonly Collection[]
  worktrees: readonly Worktree[]
  repoMap: Map<string, Repo>
  collapsedGroups: ReadonlySet<string>
  repoOrder?: Map<string, number>
}): Row[] {
  const { collections, worktrees, repoMap, collapsedGroups, repoOrder } = input
  if (collections.length === 0) {
    return []
  }
  const membersByCollection = new Map<string, Map<string, Worktree[]>>()
  for (const worktree of worktrees) {
    for (const collectionId of worktree.collectionIds ?? []) {
      let byRepo = membersByCollection.get(collectionId)
      if (!byRepo) {
        byRepo = new Map()
        membersByCollection.set(collectionId, byRepo)
      }
      const list = byRepo.get(worktree.repoId) ?? []
      list.push(worktree)
      byRepo.set(worktree.repoId, list)
    }
  }
  const rows: Row[] = []
  for (const collection of sortCollectionsByOrder(collections)) {
    const byRepo = membersByCollection.get(collection.id) ?? new Map<string, Worktree[]>()
    let memberCount = 0
    for (const list of byRepo.values()) {
      memberCount += list.length
    }
    const headerKey = getCollectionHeaderKey(collection.id)
    // Why: an empty collection still shows its header so it stays discoverable and deletable.
    rows.push({
      type: 'header',
      key: headerKey,
      label: collection.name,
      count: memberCount,
      tone: COLLECTION_GROUP_META.tone,
      icon: COLLECTION_GROUP_META.icon,
      collection
    })
    if (collapsedGroups.has(headerKey)) {
      continue
    }
    // Why: repo blocks follow the sidebar's own repo order so both views read the same.
    const repoIds = [...byRepo.keys()].sort(
      (left, right) =>
        (repoOrder?.get(left) ?? Number.MAX_SAFE_INTEGER) -
        (repoOrder?.get(right) ?? Number.MAX_SAFE_INTEGER)
    )
    for (const repoId of repoIds) {
      const repo = repoMap.get(repoId)
      const members = byRepo.get(repoId) ?? []
      const repoHeaderKey = getCollectionRepoHeaderKey(collection.id, repoId)
      rows.push({
        type: 'header',
        key: repoHeaderKey,
        label: repo?.displayName ?? repoId,
        count: members.length,
        tone: COLLECTION_GROUP_META.tone,
        repo,
        collection
      })
      if (collapsedGroups.has(repoHeaderKey)) {
        continue
      }
      for (const worktree of members) {
        rows.push({
          type: 'item',
          rowKey: `${headerKey}:${worktree.id}`,
          sectionKey: repoHeaderKey,
          worktree,
          repo,
          depth: 0,
          groupDepth: 1,
          lineageTrail: [],
          isLastLineageChild: false,
          lineageChildCount: 0
        })
      }
    }
  }
  return rows
}
