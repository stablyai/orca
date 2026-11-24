import { useAppStore } from '@/store/index'
import { findWorktreeById } from '@/store/github/refresh/worktree-refresh'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { parseWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type { DebugAdapterId, DebugBreakpoint, DebugWatchEntry } from './debug-session-types'

const BREAKPOINTS_STORAGE_KEY = 'orca.debug.breakpoints.v1'
const WATCHES_STORAGE_KEY = 'orca.debug.watches.v1'

type PersistedBreakpointEntry = {
  path: string
  breakpoints: DebugBreakpoint[]
}

function isPersistedBreakpointEntry(entry: unknown): entry is PersistedBreakpointEntry {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    'breakpoints' in entry &&
    Array.isArray(entry.breakpoints) &&
    'path' in entry &&
    typeof entry.path === 'string'
  )
}

export function normalizeDebugPathKey(filePath: string): string {
  const slashes = filePath.replace(/\\/g, '/')
  return /^[a-zA-Z]:/.test(slashes) ? slashes.toLowerCase() : slashes
}

export function inferAdapterForFile(filePath: string): DebugAdapterId {
  const lower = filePath.toLowerCase()
  if (lower.endsWith('.py')) {
    return 'debugpy'
  }
  if (lower.endsWith('.rs')) {
    return 'codelldb'
  }
  if (lower.endsWith('.go')) {
    return 'delve'
  }
  if (lower.endsWith('.rb')) {
    return 'rdbg'
  }
  if (lower.endsWith('.cs') || lower.endsWith('.fs')) {
    return 'netcoredbg'
  }
  if (
    lower.endsWith('.js') ||
    lower.endsWith('.mjs') ||
    lower.endsWith('.cjs') ||
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.mts') ||
    lower.endsWith('.cts')
  ) {
    return 'js-debug'
  }
  return 'debugpy'
}

export function resolveWorkspaceRoot(
  worktreeId?: string | null,
  filePath?: string | null,
  relativePath?: string | null
): string | null {
  if (worktreeId) {
    const state = useAppStore.getState()
    const parsed = parseWorkspaceKey(worktreeId)
    if (parsed?.type === 'folder') {
      const folder = selectFolderWorkspaces(state)?.find((f) => f.id === parsed.folderWorkspaceId)
      if (folder?.folderPath) {
        return folder.folderPath
      }
    }
    const wt = findWorktreeById(state, worktreeId)
    if (wt?.path) {
      return wt.path
    }
  }
  if (filePath && relativePath) {
    const normFile = filePath.replace(/\\/g, '/')
    const normRel = relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
    if (normRel && normFile.endsWith(`/${normRel}`)) {
      return filePath.slice(0, filePath.length - relativePath.length - 1) || null
    }
  }
  return null
}

export function resolveWorkspaceRootForFile(
  filePath: string,
  relativePath: string,
  worktreeId?: string
): string | null {
  return resolveWorkspaceRoot(worktreeId, filePath, relativePath)
}

function relativePathInRoot(root: string, filePath: string): string | null {
  const normRoot = root.replace(/\\/g, '/').replace(/\/+$/, '')
  const normFile = filePath.replace(/\\/g, '/')
  if (normFile.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) {
    return normFile.slice(normRoot.length + 1)
  }
  return null
}

export function navigateToSourceLocation(filePath: string, line: number, column = 1): void {
  if (!/^[a-zA-Z]:[\\/]|^\//.test(filePath)) {
    return
  }
  const state = useAppStore.getState()
  const key = normalizeDebugPathKey(filePath)
  const existing = state.openFiles.find((f) => normalizeDebugPathKey(f.filePath) === key)
  const worktreeId = state.activeWorktreeId ?? ''
  if (!existing) {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? 'plaintext'
    const baseName = filePath.split(/[\\/]/).at(-1) || filePath
    const root = resolveWorkspaceRoot(worktreeId, filePath)
    const relativePath = (root && relativePathInRoot(root, filePath)) || baseName
    const wt = worktreeId ? findWorktreeById(state, worktreeId) : undefined
    state.openFile(
      {
        filePath,
        relativePath,
        worktreeId,
        runtimeEnvironmentId: wt?.runtimeOwnerEnvironmentId ?? undefined,
        language: ext,
        mode: 'edit'
      },
      { focusEditor: true }
    )
  } else {
    state.setActiveFile(existing.id, existing.worktreeId || worktreeId)
    state.setActiveTabType('editor', existing.worktreeId || worktreeId)
  }
  state.setPendingEditorReveal({ filePath, line, column, matchLength: 0 })
}

export function loadPersistedBreakpoints(): {
  byKey: Record<string, DebugBreakpoint[]>
  pathsByKey: Record<string, string>
} {
  try {
    const raw = window.localStorage.getItem(BREAKPOINTS_STORAGE_KEY)
    if (!raw) {
      return { byKey: {}, pathsByKey: {} }
    }
    const parsed: unknown = JSON.parse(raw)
    const byKey: Record<string, DebugBreakpoint[]> = {}
    const pathsByKey: Record<string, string> = {}
    if (typeof parsed !== 'object' || parsed === null) {
      return { byKey, pathsByKey }
    }
    for (const [key, entry] of Object.entries(parsed)) {
      if (isPersistedBreakpointEntry(entry)) {
        byKey[key] = entry.breakpoints
        pathsByKey[key] = entry.path
      }
    }
    return { byKey, pathsByKey }
  } catch {
    return { byKey: {}, pathsByKey: {} }
  }
}

export function savePersistedBreakpoints(
  byKey: Record<string, DebugBreakpoint[]>,
  pathsByKey: Record<string, string>
): void {
  try {
    const payload: Record<string, PersistedBreakpointEntry> = {}
    for (const [key, breakpoints] of Object.entries(byKey)) {
      if (breakpoints.length > 0 && pathsByKey[key]) {
        payload[key] = { path: pathsByKey[key], breakpoints }
      }
    }
    window.localStorage.setItem(BREAKPOINTS_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    // Ignore storage unavailability in test environments.
  }
}

export function loadPersistedWatches(): DebugWatchEntry[] {
  try {
    const raw = window.localStorage.getItem(WATCHES_STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .filter((expr): expr is string => typeof expr === 'string' && expr.trim().length > 0)
      .map((expression, idx) => ({ id: `watch-${idx}-${expression}`, expression }))
  } catch {
    return []
  }
}

export function savePersistedWatches(watches: readonly DebugWatchEntry[]): void {
  try {
    window.localStorage.setItem(
      WATCHES_STORAGE_KEY,
      JSON.stringify(watches.map((w) => w.expression))
    )
  } catch {
    // Ignore storage unavailability in test environments.
  }
}
