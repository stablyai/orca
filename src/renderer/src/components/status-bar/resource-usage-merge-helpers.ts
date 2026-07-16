import type { SessionMemory } from '../../../../shared/types'
import { parseAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { parsePaneKey as parseStablePaneKey } from '../../../../shared/stable-pane-id'
import {
  getRepoIdFromWorktreeId,
  getWorktreePathBasenameFromId
} from '../../../../shared/worktree-id'
import type { DaemonSession, MergeContext } from './resource-usage-merge-types'

export function deriveRepoIdFromWorktreeId(worktreeId: string): string {
  return getRepoIdFromWorktreeId(worktreeId)
}

export function deriveWorktreeNameFromWorktreeId(worktreeId: string): string {
  return getWorktreePathBasenameFromId(worktreeId) ?? worktreeId
}

export function shortCwd(cwd: string): string {
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
  ctx: MergeContext
): string {
  const parsed = parsePaneKey(session.paneKey)
  if (parsed) {
    const tabs = ctx.tabsByWorktree[worktreeId] ?? []
    const tabIndex = tabs.findIndex((t) => t.id === parsed.tabId)
    const tab = tabIndex >= 0 ? tabs[tabIndex] : undefined
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

export function resolveSessionRoute(
  sessionId: string,
  ctx: MergeContext
): {
  connectionId: string | null
  hostLabel: string | null
  relayPtyId: string | null
} {
  const parsed = parseAppSshPtyId(sessionId)
  if (!parsed) {
    return { connectionId: null, hostLabel: null, relayPtyId: null }
  }
  return {
    connectionId: parsed.connectionId,
    hostLabel: ctx.sshTargetLabelById?.get(parsed.connectionId) ?? parsed.connectionId,
    relayPtyId: parsed.relayPtyId
  }
}

export function resolveRuntimeTerminalAttribution(
  sessionId: string,
  ctx: MergeContext
): ReturnType<NonNullable<MergeContext['runtimeTerminalByPtyId']>['get']> | null {
  return ctx.runtimeTerminalByPtyId?.get(sessionId) ?? null
}

export function resolveOrphanReason(args: {
  bound: boolean
  tabId: string | null
  worktreeId: string | null
  hasLocalSamples: boolean
}): string | null {
  if (args.bound) {
    return null
  }
  if (args.tabId) {
    return 'session is known to a tab but is not currently bound'
  }
  if (args.worktreeId) {
    return 'live PTY has a workspace but no renderer pane binding'
  }
  return args.hasLocalSamples
    ? 'local daemon session has no renderer pane binding'
    : 'daemon session has no workspace or pane binding'
}

export function resolveDaemonSessionLabel(
  session: DaemonSession,
  resolvedWorktreeId: string | null,
  tabId: string | null,
  ctx: MergeContext
): string {
  if (tabId && resolvedWorktreeId) {
    const tabs = ctx.tabsByWorktree[resolvedWorktreeId] ?? []
    const tabIndex = tabs.findIndex((t) => t.id === tabId)
    const tab = tabIndex >= 0 ? tabs[tabIndex] : undefined
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
