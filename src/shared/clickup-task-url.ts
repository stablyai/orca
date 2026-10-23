import type { ClickUpTask, ClickUpWorkspace } from './clickup-types'

export const CLICKUP_APP_ORIGIN = 'https://app.clickup.com'

export type ParsedClickUpTaskUrl = {
  // The identifier ClickUp routes on: a native task id, or a custom task id
  // when the workspace has custom ids enabled.
  taskId: string
  isCustomId: boolean
  // Only the custom-id URL form names its workspace; native ids resolve
  // without one.
  workspaceId: string | null
  origin: string
}

// Native ClickUp task ids are lowercase base-36 (e.g. "86by1abcd").
export const CLICKUP_TASK_ID_PATTERN = /^[0-9a-z]{6,24}$/
// Custom task ids follow the "<PREFIX>-<number>" shape the workspace defines.
export const CLICKUP_CUSTOM_TASK_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]*-\d+$/

export function isClickUpHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === 'clickup.com' || host.endsWith('.clickup.com')
}

export function parseClickUpTaskUrl(value: string): ParsedClickUpTaskUrl | null {
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  // Why: ClickUp is https-only, so accepting http would let a downgraded link
  // resolve to a task reference the CLI and composer then treat as trusted.
  if (
    url.protocol !== 'https:' ||
    url.port.length > 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    !isClickUpHost(url.hostname)
  ) {
    return null
  }
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments[0] !== 't') {
    return null
  }
  const origin = url.origin.toLowerCase()
  if (segments.length === 2) {
    const taskId = segments[1]
    if (CLICKUP_CUSTOM_TASK_ID_PATTERN.test(taskId)) {
      return { taskId: taskId.toUpperCase(), isCustomId: true, workspaceId: null, origin }
    }
    return CLICKUP_TASK_ID_PATTERN.test(taskId)
      ? { taskId, isCustomId: false, workspaceId: null, origin }
      : null
  }
  if (segments.length === 3) {
    const [, first, second] = segments
    // The custom-id route leads with the numeric Workspace id: /t/<team>/<ABC-12>.
    if (/^\d+$/.test(first)) {
      if (CLICKUP_CUSTOM_TASK_ID_PATTERN.test(second)) {
        return { taskId: second.toUpperCase(), isCustomId: true, workspaceId: first, origin }
      }
      return CLICKUP_TASK_ID_PATTERN.test(second)
        ? { taskId: second, isCustomId: false, workspaceId: first, origin }
        : null
    }
    // Why: ClickUp also appends a human-readable slug to a native task URL
    // (/t/<taskId>/<slug>); the id still leads, so the slug is ignored.
    return CLICKUP_TASK_ID_PATTERN.test(first)
      ? { taskId: first, isCustomId: false, workspaceId: null, origin }
      : null
  }
  return null
}

export function parseClickUpTaskInput(value: string): ParsedClickUpTaskUrl | null {
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return parseClickUpTaskUrl(trimmed)
  }
  if (CLICKUP_CUSTOM_TASK_ID_PATTERN.test(trimmed)) {
    return {
      taskId: trimmed.toUpperCase(),
      isCustomId: true,
      workspaceId: null,
      origin: CLICKUP_APP_ORIGIN
    }
  }
  return null
}

export function buildClickUpTaskUrl(args: {
  taskId: string
  customId?: string | null
  workspaceId?: string | null
}): string {
  if (args.customId && args.workspaceId) {
    return `${CLICKUP_APP_ORIGIN}/t/${args.workspaceId}/${args.customId}`
  }
  return `${CLICKUP_APP_ORIGIN}/t/${args.taskId}`
}

export function getMatchingClickUpWorkspaces(
  parsed: ParsedClickUpTaskUrl,
  workspaces: readonly ClickUpWorkspace[]
): ClickUpWorkspace[] {
  if (!parsed.workspaceId) {
    return [...workspaces]
  }
  return workspaces.filter((workspace) => workspace.id === parsed.workspaceId)
}

export function isResolvedClickUpTaskMatch(
  parsed: ParsedClickUpTaskUrl,
  task: ClickUpTask
): boolean {
  if (parsed.workspaceId && task.workspaceId !== parsed.workspaceId) {
    return false
  }
  return parsed.isCustomId
    ? (task.customId ?? '').toUpperCase() === parsed.taskId
    : task.id === parsed.taskId
}
