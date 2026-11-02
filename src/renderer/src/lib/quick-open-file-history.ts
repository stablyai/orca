import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { resolveWorktreeOperationRoute } from './worktree-operation-route'

const STORAGE_KEY = 'orca.quick-open-history.v1'
const EMPTY_HISTORY: readonly string[] = []
const MAX_HISTORY_SCOPES = 64
const MAX_HISTORY_FILES = 100
let histories: Map<string, readonly string[]> | undefined
const listeners = new Set<() => void>()

function historyMap(): Map<string, readonly string[]> {
  if (histories) {
    return histories
  }
  histories = new Map()
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(saved)) {
      for (const entry of saved.slice(-MAX_HISTORY_SCOPES)) {
        if (Array.isArray(entry) && typeof entry[0] === 'string' && Array.isArray(entry[1])) {
          histories.set(
            entry[0],
            entry[1]
              .filter((path: unknown): path is string => typeof path === 'string')
              .slice(0, MAX_HISTORY_FILES)
          )
        }
      }
    }
  } catch {
    // Storage may be unavailable; session history still works.
  }
  return histories
}

export function quickOpenHistoryScope(
  state: AppState,
  worktreeId: string,
  root: string
): string | null {
  const owner = resolveWorktreeOperationRoute(state, worktreeId)
  if (!owner) {
    return null
  }
  return JSON.stringify([owner, worktreeId, normalizeRuntimePathForComparison(root)])
}

export function readQuickOpenHistory(scope: string | null): readonly string[] {
  return scope ? (historyMap().get(scope) ?? EMPTY_HISTORY) : EMPTY_HISTORY
}

export function useQuickOpenHistory(
  worktreeId: string | null,
  root: string | null
): readonly string[] {
  const scope =
    worktreeId && root ? quickOpenHistoryScope(useAppStore.getState(), worktreeId, root) : null
  return useSyncExternalStore(subscribeQuickOpenHistory, () => readQuickOpenHistory(scope))
}

function subscribeQuickOpenHistory(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function recordQuickOpenFileVisit(state: AppState, file: OpenFile | undefined): void {
  if (!file || file.mode !== 'edit' || file.isUntitled) {
    return
  }
  const route = file.operationProvenance?.generation.route
  const worktree = state.getKnownWorktreeById?.(
    file.worktreeId,
    route?.executionHostId ?? undefined
  )
  if (!worktree) {
    return
  }
  const currentRoute = resolveWorktreeOperationRoute(state, file.worktreeId)
  if (
    route &&
    (route.executionHostId !== currentRoute?.executionHostId ||
      route.runtimeEnvironmentId !== currentRoute?.runtimeEnvironmentId)
  ) {
    return
  }
  const scope = quickOpenHistoryScope(state, file.worktreeId, worktree.path)
  if (!scope) {
    return
  }
  const map = historyMap()
  const previous = map.get(scope) ?? EMPTY_HISTORY
  if (previous[0] === file.relativePath) {
    return
  }
  map.delete(scope)
  map.set(
    scope,
    [file.relativePath, ...previous.filter((path) => path !== file.relativePath)].slice(
      0,
      MAX_HISTORY_FILES
    )
  )
  saveHistories(map)
}

/**
 * Adds each re-keyed history beside its source, at the same recency. A full store makes room by
 * dropping copied sources, oldest first, never another scope. Throws when storage refuses the write.
 */
export function copyQuickOpenHistoryScopes(copyScopeOf: (scope: string) => string | null): boolean {
  const map = historyMap()
  const next = new Map<string, readonly string[]>()
  const copiedSources: string[] = []
  for (const [scope, files] of map) {
    next.set(scope, files)
    const copy = copyScopeOf(scope)
    if (copy !== null && !map.has(copy) && !next.has(copy)) {
      next.set(copy, files)
      copiedSources.push(scope)
    }
  }
  if (copiedSources.length === 0) {
    return false
  }
  for (const source of copiedSources) {
    if (next.size <= MAX_HISTORY_SCOPES) {
      break
    }
    next.delete(source)
  }
  histories = next
  if (!saveHistories(next)) {
    throw new Error('quick_open_history_not_saved')
  }
  return true
}

function saveHistories(map: Map<string, readonly string[]>): boolean {
  while (map.size > MAX_HISTORY_SCOPES) {
    const oldest = map.keys().next().value
    if (oldest === undefined) {
      break
    }
    map.delete(oldest)
  }
  let saved = true
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...map]))
  } catch {
    saved = false
  }
  listeners.forEach((listener) => listener())
  return saved
}
