import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type {
  RuntimeWorktreePsSummary,
  RuntimeWorktreeStatus
} from '../../../../shared/runtime-worktree-contracts'

export type MobileSessionStatus = 'working' | 'attention' | 'idle'

export type MobileSessionCard = {
  sessionId: string
  agent: string
  status: MobileSessionStatus
  title: string
  preview: string
  updatedAt: number
  toolName: string | null
}

export type MobileWorkspaceGroup = {
  workspaceId: string
  name: string
  path: string
  branch: string
  isActive: boolean
  unread: boolean
  status: RuntimeWorktreeStatus
  lastActivityAt: number
  sessions: MobileSessionCard[]
}

const MAX_TITLE_LENGTH = 96
const MAX_PREVIEW_LENGTH = 160
const OTHER_WORKSPACE_ID = '__mobile_other_workspaces__'

function squish(value: string): string {
  return value.replace(/\s+/gu, ' ').trim()
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value
}

export function mobileSessionStatus(
  status: AgentSessionStatusSummary['status']
): MobileSessionStatus {
  return status === 'working' ? 'working' : status === 'attention' ? 'attention' : 'idle'
}

export function mobileSessionTitle(session: AgentSessionStatusSummary): string {
  const name = session.conversationName ? squish(session.conversationName) : ''
  const prompt = session.latestPrompt ? squish(session.latestPrompt) : ''
  return truncate(name || prompt || `${session.agent} session`, MAX_TITLE_LENGTH)
}

export function mobileSessionPreview(session: AgentSessionStatusSummary): string {
  const preview = session.lastAssistantMessage
    ? squish(session.lastAssistantMessage)
    : session.latestPrompt
      ? squish(session.latestPrompt)
      : ''
  return truncate(preview, MAX_PREVIEW_LENGTH)
}

export function toMobileSessionCard(session: AgentSessionStatusSummary): MobileSessionCard {
  return {
    sessionId: session.sessionId,
    agent: session.agent,
    status: mobileSessionStatus(session.status),
    title: mobileSessionTitle(session),
    preview: mobileSessionPreview(session),
    updatedAt: session.updatedAt,
    toolName: session.status === 'working' ? (session.toolName ?? null) : null
  }
}

function sessionRank(status: MobileSessionStatus): number {
  return status === 'attention' ? 0 : status === 'working' ? 1 : 2
}

function sortedSessions(sessions: readonly MobileSessionCard[]): MobileSessionCard[] {
  return [...sessions].sort(
    (left, right) =>
      sessionRank(left.status) - sessionRank(right.status) || right.updatedAt - left.updatedAt
  )
}

function workspaceName(worktree: RuntimeWorktreePsSummary): string {
  const displayName = worktree.displayName?.trim()
  if (displayName) {
    return displayName
  }
  const branch = worktree.branch?.trim()
  if (branch) {
    return branch
  }
  const path = worktree.path?.replace(/[\\/]+$/u, '') ?? ''
  const lastSegment = path.split(/[\\/]/u).pop()
  return lastSegment || worktree.worktreeId
}

function workspaceRank(group: MobileWorkspaceGroup): number {
  if (group.sessions.length === 0) {
    return 3
  }
  return Math.min(...group.sessions.map((session) => sessionRank(session.status)))
}

/**
 * Join the host's worktree catalog with the structured-session status feed.
 * `worktree.ps` agent rows are terminal/OSC rows and do not carry a structured
 * session id, so the status feed is the only safe source for chat navigation.
 */
export function buildMobileWorkspaces({
  worktrees,
  sessions
}: {
  worktrees: readonly RuntimeWorktreePsSummary[]
  sessions: readonly AgentSessionStatusSummary[]
}): MobileWorkspaceGroup[] {
  const byWorkspace = new Map<string, AgentSessionStatusSummary[]>()
  for (const session of sessions) {
    const existing = byWorkspace.get(session.workspaceId)
    if (existing) {
      existing.push(session)
    } else {
      byWorkspace.set(session.workspaceId, [session])
    }
  }

  const groups: MobileWorkspaceGroup[] = worktrees.map((worktree) => {
    const cards = sortedSessions(
      (byWorkspace.get(worktree.worktreeId) ?? []).map(toMobileSessionCard)
    )
    return {
      workspaceId: worktree.worktreeId,
      name: workspaceName(worktree),
      path: worktree.path,
      branch: worktree.branch,
      isActive: worktree.isActive,
      unread: worktree.unread,
      status: worktree.status,
      lastActivityAt:
        cards.reduce((latest, session) => Math.max(latest, session.updatedAt), 0) ||
        worktree.lastActivityAt ||
        0,
      sessions: cards
    }
  })

  const knownWorkspaceIds = new Set(worktrees.map((worktree) => worktree.worktreeId))
  const orphanSessions = sessions
    .filter((session) => !knownWorkspaceIds.has(session.workspaceId))
    .map(toMobileSessionCard)
  if (orphanSessions.length > 0) {
    groups.push({
      workspaceId: OTHER_WORKSPACE_ID,
      name: 'Other tasks',
      path: '',
      branch: '',
      isActive: false,
      unread: orphanSessions.some((session) => session.status === 'attention'),
      status: 'inactive',
      lastActivityAt: orphanSessions.reduce(
        (latest, session) => Math.max(latest, session.updatedAt),
        0
      ),
      sessions: sortedSessions(orphanSessions)
    })
  }

  return groups.sort(
    (left, right) =>
      workspaceRank(left) - workspaceRank(right) ||
      right.lastActivityAt - left.lastActivityAt ||
      left.name.localeCompare(right.name)
  )
}

export function formatMobileRelativeTime(timestamp: number, now: number = Date.now()): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return ''
  }
  const delta = Math.max(0, now - timestamp)
  if (delta < 45_000) {
    return 'now'
  }
  if (delta < 3_600_000) {
    return `${Math.round(delta / 60_000)}m`
  }
  if (delta < 86_400_000) {
    return `${Math.round(delta / 3_600_000)}h`
  }
  return `${Math.round(delta / 86_400_000)}d`
}

export function mobileAgentLabel(agent: string): string {
  switch (agent) {
    case 'claude':
      return 'Claude'
    case 'codex':
      return 'Codex'
    case 'cursor':
      return 'Cursor'
    case 'grok':
      return 'Grok'
    case 'opencode':
      return 'OpenCode'
    default:
      return agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : 'Agent'
  }
}
