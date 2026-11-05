import { z } from 'zod'
import { clampUtf8TextPrefix } from '../../utf8-byte-limits'
import type { WorkspaceSessionState } from '../../workspace-session/workspace-session-state-types'
import type { WorkspaceVisibleTabType } from '../../tab-types'

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
  | 'activeWorktreeId'
  | 'activeTabTypeByWorktree'
  | 'unifiedTabs'
  | 'tabGroups'
  | 'activeGroupIdByWorktree'
>

const KIND_BY_TAB_TYPE: Partial<
  Record<WorkspaceVisibleTabType, NonNullable<PluginFocusedSurface>['kind']>
> = {
  terminal: 'terminal',
  'agent-session': 'agent',
  editor: 'editor',
  browser: 'browser'
}

/** The surface the person is looking at; null while Orca's window is unfocused or no tab is active. */
export function readPluginFocusedSurface(
  session: FocusSession,
  windowFocused: boolean
): PluginFocusedSurface {
  const worktreeId = session.activeWorktreeId
  const tabType = worktreeId ? session.activeTabTypeByWorktree?.[worktreeId] : undefined
  const kind = tabType ? KIND_BY_TAB_TYPE[tabType] : undefined
  if (!windowFocused || !worktreeId || !kind) {
    return null
  }
  const groups = session.tabGroups?.[worktreeId] ?? []
  const activeGroupId = session.activeGroupIdByWorktree?.[worktreeId]
  const group = groups.find((entry) => entry.id === activeGroupId) ?? groups[0]
  const tab = session.unifiedTabs?.[worktreeId]?.find((entry) => entry.id === group?.activeTabId)
  const title = projectPluginFocusedTitle(tab?.customLabel ?? tab?.generatedLabel ?? tab?.label)
  return {
    kind,
    title,
    ...(kind === 'agent' && tab && tab.id.length <= PLUGIN_FOCUSED_AGENT_ID_MAX_LENGTH
      ? { agentId: tab.id }
      : {})
  }
}

export function projectPluginFocusedTitle(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim()
  if (!trimmed) {
    return null
  }
  return clampUtf8TextPrefix(sanitizeTitle(trimmed), PLUGIN_FOCUSED_SURFACE_TITLE_MAX_BYTES)
}

function sanitizeTitle(value: string): string {
  const hostname = httpHostname(value)
  if (hostname !== null) {
    return hostname
  }
  if (!/[\\/]/.test(value)) {
    return value
  }
  const withoutTrailing = value.replace(/[\\/]+$/, '')
  return withoutTrailing.split(/[\\/]/).pop() || withoutTrailing
}

function httpHostname(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null
  } catch {
    return null
  }
}
