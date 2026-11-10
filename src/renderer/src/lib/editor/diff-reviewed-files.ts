import { useSyncExternalStore } from 'react'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'
import type { getEditorFileReadContext } from './file-operations/editor-file-operation-owner'
import type { GitStatusEntry } from '../../../../shared/git/status/git-status-types'
import type { DiffSource } from '../../../../shared/editor-tab-view-types'

export type DiffReviewOwner = ReturnType<typeof getEditorFileReadContext>
export type ReviewedDiff = {
  viewedAt: number
  modifiedTime: number | null
  contentSignature: string
  entrySignature: string
}
const MAX_RECORDS = 5000
const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000
const STORAGE_KEY = 'orca.reviewed-diffs.v1'
const listeners = new Set<() => void>()
let records: ReadonlyMap<string, ReviewedDiff> | undefined

export type DiffReviewEntry = Pick<GitStatusEntry, 'path' | 'oldPath' | 'added' | 'removed'> & {
  status: string
}

export function reviewEntrySignature(entry: DiffReviewEntry): string {
  return JSON.stringify([entry.status, entry.oldPath, entry.added, entry.removed])
}

export function entryReviewSource(entry: Pick<GitStatusEntry, 'area'>): 'staged' | 'unstaged' {
  return entry.area === 'staged' ? 'staged' : 'unstaged'
}

export function diffReviewScope(file: {
  diffSource?: DiffSource
  branchCompare?: { mergeBase: string | null; headOid: string | null } | null
  commitCompare?: { parentOid: string | null; commitOid: string }
}): string {
  if (file.diffSource === 'branch') {
    return JSON.stringify(['branch', file.branchCompare?.mergeBase, file.branchCompare?.headOid])
  }
  if (file.diffSource === 'commit') {
    return JSON.stringify(['commit', file.commitCompare?.parentOid, file.commitCompare?.commitOid])
  }
  return file.diffSource === 'staged' ? 'staged' : 'unstaged'
}

export function diffReviewOwnerKey(owner: DiffReviewOwner): string {
  return JSON.stringify([
    owner.target,
    owner.expectedExecutionHostId,
    owner.worktreeId,
    owner.worktreePath ? normalizeRuntimePathForComparison(owner.worktreePath) : null
  ])
}

export function diffReviewKey(owner: DiffReviewOwner, path: string, scope: string): string {
  return JSON.stringify([diffReviewOwnerKey(owner), path, scope])
}

export function getReviewedDiffs(): ReadonlyMap<string, ReviewedDiff> {
  if (records) {
    return records
  }
  const loaded = new Map<string, ReviewedDiff>()
  try {
    const data: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(data)) {
      for (const row of data) {
        if (!Array.isArray(row) || typeof row[0] !== 'string') {
          continue
        }
        const value = row[1]
        if (
          value &&
          typeof value.viewedAt === 'number' &&
          Number.isFinite(value.viewedAt) &&
          (value.modifiedTime === null ||
            (typeof value.modifiedTime === 'number' && Number.isFinite(value.modifiedTime))) &&
          typeof value.contentSignature === 'string' &&
          typeof value.entrySignature === 'string'
        ) {
          loaded.set(row[0], value)
        }
      }
    }
  } catch {
    /* Storage can be unavailable; keep review marks for this session. */
  }
  records = loaded
  return records
}

export function setDiffReviewed(key: string, value: ReviewedDiff | null): void {
  const next = new Map(getReviewedDiffs())
  if (value) {
    next.set(key, value)
  } else if (!next.delete(key)) {
    return
  }
  const cutoff = Date.now() - MAX_AGE_MS
  for (const [recordKey, record] of next) {
    if (record.viewedAt < cutoff) {
      next.delete(recordKey)
    }
  }
  if (next.size > MAX_RECORDS) {
    const oldest = [...next].sort((a, b) => a[1].viewedAt - b[1].viewedAt)
    for (const [recordKey] of oldest.slice(0, next.size - MAX_RECORDS)) {
      next.delete(recordKey)
    }
  }
  records = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]))
  } catch {
    /* Keep session state. */
  }
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY && event.key !== null) {
      return
    }
    records = undefined
    for (const listener of listeners) {
      listener()
    }
  })
}

export function useReviewedDiffs(): ReadonlyMap<string, ReviewedDiff> {
  return useSyncExternalStore(subscribe, getReviewedDiffs)
}
