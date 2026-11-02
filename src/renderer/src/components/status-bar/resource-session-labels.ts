import type { SessionMemory } from '../../../../shared/process-stats-types'
import { parsePaneKey as parseStablePaneKey } from '../../../../shared/stable-pane-id'
import { getWorktreePathBasenameFromId } from '../../../../shared/worktree/id'
import type { DaemonSession, MergeContext } from './resource-usage-merge-types'
import type { ResourceSessionBindingIndex } from './resource-session-bindings'

export function deriveWorktreeNameFromWorktreeId(worktreeId: string): string {
  return getWorktreePathBasenameFromId(worktreeId) ?? worktreeId
}

function shortCwd(cwd: string): string {
  if (!cwd) {
    return ''
  }
  const sep = cwd.includes('\\') ? '\\' : '/'
  const parts = cwd.split(/[\\/]+/).filter(Boolean)
  return parts.length > 2 ? parts.slice(-2).join(sep) : cwd
}

function parsePaneKey(paneKey: string | null): { tabId: string; leafId: string } | null {
  if (!paneKey) {
    return null
  }
  const parsed = parseStablePaneKey(paneKey)
  return parsed ? { tabId: parsed.tabId, leafId: parsed.leafId } : null
}

export function resolveSnapshotSessionLabel(
  session: SessionMemory,
  worktreeId: string,
  index: ResourceSessionBindingIndex
): string {
  const parsed = parsePaneKey(session.paneKey)
  if (parsed) {
    const match = index.tabsByIdByWorktree.get(worktreeId)?.get(parsed.tabId)
    const tab = match?.tab
    const tabIndex = match?.index ?? -1
    if (tab) {
      const custom = tab.customTitle?.trim()
      if (custom) {
        return custom
      }
      return tab.defaultTitle?.trim() || tab.title?.trim() || `Terminal ${tabIndex + 1}`
    }
  }
  if (session.pid > 0) {
    return `pid ${session.pid}`
  }
  const fallback = session.sessionId?.slice(0, 8)
  return fallback ? `session ${fallback}` : '(unknown session)'
}

export function resolveDaemonSessionLabel(
  session: DaemonSession,
  resolvedWorktreeId: string | null,
  tabId: string | null,
  ctx: MergeContext,
  index: ResourceSessionBindingIndex
): string {
  if (tabId && resolvedWorktreeId) {
    const tab = index.tabsByIdByWorktree.get(resolvedWorktreeId)?.get(tabId)?.tab
    if (tab) {
      const custom = tab.customTitle?.trim()
      if (custom) {
        return custom
      }
      const runtimeMap = ctx.runtimePaneTitlesByTabId[tabId]
      if (runtimeMap) {
        const live = Object.values(runtimeMap).find((t) => t?.trim())
        if (live) {
          return live
        }
      }
      const fallback = tab.defaultTitle?.trim() || tab.title?.trim()
      if (fallback) {
        return fallback
      }
    }
  }
  if (session.cwd) {
    return shortCwd(session.cwd)
  }
  if (resolvedWorktreeId) {
    return shortCwd(resolvedWorktreeId)
  }
  if (session.title) {
    return session.title
  }
  return 'unknown'
}
