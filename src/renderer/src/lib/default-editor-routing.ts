import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { useAppStore } from '@/store'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import type { GlobalSettings } from '../../../shared/global-settings-types'

export const DEFAULT_EDITOR_MODES = ['builtin', 'system', 'custom'] as const
export type DefaultEditorMode = (typeof DEFAULT_EDITOR_MODES)[number]

export function normalizeDefaultEditorMode(value: unknown): DefaultEditorMode {
  return value === 'system' || value === 'custom' ? value : 'builtin'
}

export function resolveDefaultEditorMode(settings: GlobalSettings | null): DefaultEditorMode {
  return normalizeDefaultEditorMode(settings?.defaultEditorMode)
}

export function resolveDefaultEditorCustomCommand(settings: GlobalSettings | null): string {
  return settings?.defaultEditorCustomCommand?.trim() ?? ''
}

/** POSIX single-quote / Windows double-quote shell escaping for a path argument. */
export function quoteShellPathArgument(pathValue: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    if (/^[a-zA-Z0-9_./@:\\-]+$/.test(pathValue)) {
      return pathValue
    }
    return `"${pathValue.replace(/"/g, '""')}"`
  }
  if (/^[a-zA-Z0-9_./@:-]+$/.test(pathValue)) {
    return pathValue
  }
  return `'${pathValue.replace(/'/g, "'\\''")}'`
}

export function buildDefaultEditorShellCommand(
  command: string,
  pathValue: string,
  platform: NodeJS.Platform
): string {
  return `${command.trim()} ${quoteShellPathArgument(pathValue, platform)}`
}

/** WSL worktrees run their terminals inside the distro, so UNC paths must be
 *  converted back to Linux paths before the command is typed. */
export function resolveTerminalPathForCommand(
  filePath: string,
  worktreePath: string | undefined
): string {
  if (!worktreePath) {
    return filePath
  }
  const wslWorktree = parseWslUncPath(worktreePath)
  if (!wslWorktree) {
    return filePath
  }
  return parseWslUncPath(filePath)?.linuxPath ?? filePath
}

export function openCustomEditorTerminalTab(args: {
  command: string
  filePath: string
  worktreeId: string
  worktreePath?: string
  groupId?: string | null
}): boolean {
  const { command, filePath, worktreeId, worktreePath, groupId } = args
  const trimmed = command.trim()
  // Why: an unresolved worktree (empty id) would create a stranded tab that
  // belongs to no worktree; fall back to the built-in editor instead.
  if (!trimmed || !worktreeId) {
    return false
  }
  const store = useAppStore.getState()
  const shellCommand = buildDefaultEditorShellCommand(
    trimmed,
    resolveTerminalPathForCommand(filePath, worktreePath),
    getRendererAppPlatform()
  )
  const targetGroupId = groupId ?? store.activeGroupIdByWorktree[worktreeId] ?? undefined
  const tab = store.createTab(worktreeId, targetGroupId, undefined, {
    quickCommandLabel: trimmed
  })
  store.queueTabStartupCommand(tab.id, { command: shellCommand })
  store.setActiveTab(tab.id)
  store.setActiveTabType('terminal')
  const latest = useAppStore.getState()
  const currentTerminals = latest.tabsByWorktree[worktreeId] ?? []
  const currentEditors = latest.openFiles.filter((file) => file.worktreeId === worktreeId)
  const currentBrowsers = latest.browserTabsByWorktree[worktreeId] ?? []
  const stored = latest.tabBarOrderByWorktree[worktreeId]
  const validIds = new Set([
    ...currentTerminals.map((tabEntry) => tabEntry.id),
    ...currentEditors.map((file) => file.id),
    ...currentBrowsers.map((browserTab) => browserTab.id)
  ])
  const base = (stored ?? []).filter((id) => validIds.has(id))
  const inBase = new Set(base)
  for (const id of validIds) {
    if (!inBase.has(id)) {
      base.push(id)
    }
  }
  latest.setTabBarOrder(worktreeId, [...base.filter((id) => id !== tab.id), tab.id])
  focusTerminalTabSurface(tab.id)
  return true
}

export type DefaultEditorRoute = 'builtin' | 'system' | 'custom' | 'remote'

export function canRouteToExternalEditor(args: {
  connectionId?: string | null
  runtimeEnvironmentId?: string | null
}): boolean {
  return !args.connectionId && !args.runtimeEnvironmentId?.trim()
}

export async function routeFileOpenToDefaultEditor(args: {
  filePath: string
  worktreeId: string
  worktreePath?: string
  runtimeEnvironmentId?: string | null
  connectionId?: string | null
  groupId?: string | null
  settings?: GlobalSettings | null
}): Promise<DefaultEditorRoute> {
  const settings = args.settings ?? useAppStore.getState().settings
  const mode = resolveDefaultEditorMode(settings)
  if (mode === 'builtin') {
    return 'builtin'
  }
  if (!canRouteToExternalEditor(args)) {
    return 'remote'
  }
  if (mode === 'system') {
    // Why: an IPC failure (main-process exception, dead bridge) must not
    // reject the whole routing promise; fall back to the built-in editor.
    try {
      const opened = await window.api.shell.openFilePath(args.filePath)
      return opened ? 'system' : 'builtin'
    } catch {
      return 'builtin'
    }
  }
  const command = resolveDefaultEditorCustomCommand(settings)
  if (!command) {
    return 'builtin'
  }
  const opened = openCustomEditorTerminalTab({
    command,
    filePath: args.filePath,
    worktreeId: args.worktreeId,
    worktreePath: args.worktreePath,
    groupId: args.groupId
  })
  return opened ? 'custom' : 'builtin'
}
