import type { AiVaultListResult, AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Tab } from '../../../../shared/tab-types'
import { defaultAgentChatLabel } from '../../../../shared/agent-session-chat-label'
import { isAgentSessionConversationName } from '../../../../shared/agent-session-conversation-name'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../../shared/runtime-types'
import { structuredChatTabBySessionId } from '@/lib/structured-chat-tab-index'

export type StructuredTitlesByWorktree = Readonly<Record<string, readonly Tab[] | undefined>>
export type AiVaultSavedTitle = {
  executionHostId: ExecutionHostId
  workspaceId: string
  sessionId: string
  agent: 'claude' | 'codex'
  title: string
}
export type AiVaultTitleProjection =
  | { kind: 'tabs'; tabs: StructuredTitlesByWorktree }
  | { kind: 'saved'; titles: readonly AiVaultSavedTitle[] }

export function savedAiVaultTitleFromSnapshot(
  snapshot: Pick<RuntimeMobileSessionTabsResult, 'worktree' | 'structuredConversationTitle'>,
  executionHostId: ExecutionHostId
): AiVaultSavedTitle | null {
  const value: unknown = snapshot.structuredConversationTitle
  if (
    typeof value !== 'object' ||
    value === null ||
    !('sessionId' in value) ||
    !('agent' in value) ||
    !('title' in value) ||
    typeof value.sessionId !== 'string' ||
    !value.sessionId.trim() ||
    value.sessionId.length > 512 ||
    (value.agent !== 'claude' && value.agent !== 'codex') ||
    !isAgentSessionConversationName(value.title)
  ) {
    return null
  }
  return {
    executionHostId,
    workspaceId: snapshot.worktree,
    sessionId: value.sessionId,
    agent: value.agent,
    title: value.title
  }
}

export function projectAiVaultSavedTitle(
  result: AiVaultListResult,
  title: AiVaultSavedTitle
): AiVaultListResult {
  return projectAiVaultSavedTitles(result, [title])
}

export function aiVaultSavedTitleIdentity(title: {
  executionHostId: ExecutionHostId
  workspaceId: string
  agent: string
  sessionId: string
}): string {
  return JSON.stringify([title.executionHostId, title.workspaceId, title.agent, title.sessionId])
}

function projectAiVaultSavedTitles(
  result: AiVaultListResult,
  titles: readonly AiVaultSavedTitle[]
): AiVaultListResult {
  const byOwner = new Map(titles.map((title) => [aiVaultSavedTitleIdentity(title), title]))
  let sessions: AiVaultSession[] | undefined
  for (const index of nativeRows(result)) {
    const session = result.sessions[index]
    const owner = session.structuredSession
    const title = owner
      ? byOwner.get(
          aiVaultSavedTitleIdentity({
            executionHostId: session.executionHostId,
            workspaceId: owner.workspaceId,
            agent: session.agent,
            sessionId: owner.sessionId
          })
        )
      : undefined
    if (!title || session.title === title.title) {
      continue
    }
    sessions ??= [...result.sessions]
    sessions[index] = { ...session, title: title.title }
  }
  return sessions ? { ...result, sessions } : result
}

export function applyAiVaultTitleProjection(
  result: AiVaultListResult,
  update: AiVaultTitleProjection
): AiVaultListResult {
  return update.kind === 'tabs'
    ? projectAiVaultStructuredTitles(result, update.tabs)
    : projectAiVaultSavedTitles(result, update.titles)
}

export function aiVaultStructuredTitlesChanged(
  current: StructuredTitlesByWorktree,
  previous: StructuredTitlesByWorktree
): boolean {
  if (current === previous) {
    return false
  }
  for (const [workspaceId, tabs] of Object.entries(current)) {
    if (!tabs || tabs === previous[workspaceId]) {
      continue
    }
    for (const tab of tabs) {
      if (tab.contentType !== 'agent-session') {
        continue
      }
      const before = structuredChatTabBySessionId(previous[workspaceId], tab.entityId)
      if (
        !before ||
        before.label !== tab.label ||
        before.agentSessionAgent !== tab.agentSessionAgent ||
        before.executionHostId !== tab.executionHostId
      ) {
        return true
      }
    }
  }
  return false
}

const structuredRowIndexes = new WeakMap<AiVaultListResult, readonly number[]>()

export function nativeRows(result: AiVaultListResult): readonly number[] {
  let indexes = structuredRowIndexes.get(result)
  if (!indexes) {
    indexes = result.sessions.flatMap((session, index) =>
      session.structuredSession ? [index] : []
    )
    structuredRowIndexes.set(result, indexes)
  }
  return indexes
}

export function projectAiVaultStructuredTitles(
  result: AiVaultListResult,
  tabsByWorktree: StructuredTitlesByWorktree
): AiVaultListResult {
  let sessions: AiVaultSession[] | undefined
  for (const index of nativeRows(result)) {
    const session = result.sessions[index]
    const title = structuredConversationTitle(session, ownedStructuredTab(session, tabsByWorktree))
    if (!title || title === session.title) {
      continue
    }
    sessions ??= [...result.sessions]
    sessions[index] = { ...session, title }
  }
  return sessions ? { ...result, sessions } : result
}

function ownedStructuredTab(
  session: AiVaultSession,
  tabsByWorktree: StructuredTitlesByWorktree
): Tab | undefined {
  const owner = session.structuredSession
  if (!owner) {
    return undefined
  }
  const tab = structuredChatTabBySessionId(tabsByWorktree[owner.workspaceId], owner.sessionId)
  return tab?.agentSessionAgent === session.agent &&
    (tab.executionHostId ?? 'local') === session.executionHostId
    ? tab
    : undefined
}

function structuredConversationTitle(session: AiVaultSession, tab: Tab | undefined): string | null {
  const title = tab?.label.trim()
  // The default provider label must not replace a name already returned by its host.
  return title && title !== defaultAgentChatLabel(session.agent) ? title : null
}

export function aiVaultSessionDisplayTitle(
  session: AiVaultSession,
  tabsByWorktree: StructuredTitlesByWorktree
): string {
  const tab = ownedStructuredTab(session, tabsByWorktree)
  return tab?.customLabel?.trim() || tab?.label.trim() || session.title
}

function projectedMetadataEqual(current: AiVaultSession, incoming: AiVaultSession): boolean {
  return (
    current.title === incoming.title &&
    current.structuredSession?.sessionId === incoming.structuredSession?.sessionId &&
    current.structuredSession?.workspaceId === incoming.structuredSession?.workspaceId
  )
}

// Names and ownership are projected after scanning, independently of its timestamp.
export function aiVaultProjectedMetadataEqual(
  current: AiVaultListResult,
  incoming: AiVaultListResult
): boolean {
  return (
    current.sessions.length === incoming.sessions.length &&
    current.sessions.every((session, index) => {
      const next = incoming.sessions[index]
      return (
        session.id === next.id &&
        session.executionHostId === next.executionHostId &&
        projectedMetadataEqual(session, next)
      )
    })
  )
}

export function mergeAiVaultStructuredMetadata(
  current: AiVaultListResult,
  incoming: AiVaultListResult
): AiVaultListResult {
  const incomingById = new Map(
    incoming.sessions.map((session) => [
      JSON.stringify([session.executionHostId, session.id]),
      session
    ])
  )
  let changed = false
  const sessions = current.sessions.map((session) => {
    const next = incomingById.get(JSON.stringify([session.executionHostId, session.id]))
    if (
      !next ||
      (!session.structuredSession && !next.structuredSession) ||
      projectedMetadataEqual(session, next)
    ) {
      return session
    }
    changed = true
    return { ...session, title: next.title, structuredSession: next.structuredSession }
  })
  return changed ? { ...current, sessions } : current
}

function structuredSessionIdentity(session: AiVaultSession): string {
  return JSON.stringify([
    session.executionHostId,
    session.agent,
    session.id,
    session.sessionId,
    session.structuredSession?.workspaceId,
    session.structuredSession?.sessionId
  ])
}

// Carry title publications across a request that started before them, without overriding later requests.
export function mergeAiVaultStructuredTitleChanges(
  result: AiVaultListResult,
  before: AiVaultListResult | null,
  after: AiVaultListResult | null
): AiVaultListResult {
  if (!after || before === after) {
    return result
  }
  const beforeById = new Map(
    before?.sessions.map((session) => [structuredSessionIdentity(session), session.title])
  )
  const changedTitles = new Map<string, string>()
  for (const index of nativeRows(after)) {
    const session = after.sessions[index]
    const identity = structuredSessionIdentity(session)
    if (beforeById.get(identity) !== session.title) {
      changedTitles.set(identity, session.title)
    }
  }
  if (changedTitles.size === 0) {
    return result
  }
  let changed = false
  const sessions = result.sessions.map((session) => {
    const title = session.structuredSession
      ? changedTitles.get(structuredSessionIdentity(session))
      : undefined
    if (title === undefined || title === session.title) {
      return session
    }
    changed = true
    return { ...session, title }
  })
  return changed ? { ...result, sessions } : result
}
