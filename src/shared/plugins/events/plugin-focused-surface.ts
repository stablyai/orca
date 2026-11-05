import { z } from 'zod'
import { clampUtf8TextPrefix } from '../../utf8-byte-limits'
import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'

export const PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES = 80
const PLUGIN_FOCUSED_AGENT_ID_MAX_LENGTH = 2048

export const PLUGIN_FOCUSED_SURFACE_KINDS = ['terminal', 'agent', 'editor', 'browser'] as const

/** What `ui.readFocus` answers and `ui.focus.changed` carries: a coarse kind and a short title, never a path or URL. */
export const pluginFocusedSurfaceSchema = z
  .object({
    kind: z.enum(PLUGIN_FOCUSED_SURFACE_KINDS),
    /** The tab's title: a basename for paths, a hostname for URLs, at most 80 bytes. */
    title: z.string().max(PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES).nullable(),
    /** Agent tabs only: `agent.status.changed` rows of this agent have `paneKey` starting with `${agentId}:`. */
    agentId: z.string().min(1).max(PLUGIN_FOCUSED_AGENT_ID_MAX_LENGTH).optional()
  })
  .strict()
  .nullable()

export type PluginFocusedSurface = z.output<typeof pluginFocusedSurfaceSchema>

type FocusSession = Pick<
  WorkspaceSessionState,
  'activeWorktreeId' | 'unifiedTabs' | 'tabGroups' | 'activeGroupIdByWorktree'
>
type FocusTab = NonNullable<WorkspaceSessionState['unifiedTabs']>[string][number]

const KIND_BY_CONTENT_TYPE: Partial<
  Record<FocusTab['contentType'], NonNullable<PluginFocusedSurface>['kind']>
> = {
  terminal: 'terminal',
  'agent-session': 'agent',
  editor: 'editor',
  diff: 'editor',
  'conflict-review': 'editor',
  'check-details': 'editor',
  browser: 'browser'
}

/** The surface the person is looking at; null while Orca's window is unfocused or no tab is active. */
export function readPluginFocusedSurface(
  session: FocusSession,
  windowFocused: boolean
): PluginFocusedSurface {
  const worktreeId = session.activeWorktreeId
  if (!windowFocused || !worktreeId) {
    return null
  }
  const groups = session.tabGroups?.[worktreeId] ?? []
  const activeGroupId = session.activeGroupIdByWorktree?.[worktreeId]
  const group = groups.find((entry) => entry.id === activeGroupId) ?? groups[0]
  const tab = session.unifiedTabs?.[worktreeId]?.find((entry) => entry.id === group?.activeTabId)
  // Why the tab's own type: a separately stored active type can lag it and mislabel the tab.
  const kind = tab ? KIND_BY_CONTENT_TYPE[tab.contentType] : undefined
  if (!tab || !kind) {
    return null
  }
  const title = projectPluginFocusedTitle(tab.customLabel ?? tab.generatedLabel ?? tab.label)
  return {
    kind,
    title,
    ...(kind === 'agent' && tab.id.length <= PLUGIN_FOCUSED_AGENT_ID_MAX_LENGTH
      ? { agentId: tab.id }
      : {})
  }
}

export function projectPluginFocusedTitle(raw: string | null | undefined): string | null {
  const title = raw?.trim() ? sanitizeTitle(raw.trim()) : null
  return title ? clampUtf8TextPrefix(title, PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES) : null
}

/** A hostname for `scheme://` URLs, a basename for other paths, null for mail and phone links. */
function sanitizeTitle(value: string): string | null {
  // Why the http family too: `https:host?query` parses as a URL without the slashes.
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^(https?|wss?|ftp):/i.test(value)) {
    return urlTitle(value)
  }
  if (/^(mailto|tel|sms):/i.test(value)) {
    return null
  }
  if (!/[\\/]/.test(value)) {
    return value
  }
  const withoutTrailing = value.replace(/[?#].*$/, '').replace(/[\\/]+$/, '')
  return withoutTrailing.split(/[\\/]/).pop() || null
}

// Why URL parsing: it drops userinfo, query and fragment, which a slash split would keep.
function urlTitle(value: string): string | null {
  try {
    const url = new URL(value)
    const basename = url.pathname.split('/').findLast(Boolean) ?? null
    // Why: a file URL's host is a file server, which the basename-only rule for files keeps private.
    return url.protocol === 'file:' ? basename : url.hostname || basename
  } catch {
    return null
  }
}
