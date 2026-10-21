import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AgentSessionWorkspaceKind } from '../../../shared/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { projectGroupIdFromRepoId } from '../../../shared/folder-workspace-worktree'
import type { RepoIcon } from '../../../shared/repo-icon'
import type { AgentSessionRestartActivity } from '../../../shared/agent-session-restart-activity'
import type { StructuredAgentId } from '../../../shared/agent-session-provider-handle'

/**
 * The offered chats, arranged the way the sidebar arranges workspaces: project/repo, then workspace,
 * then the agent sessions inside it.
 *
 * Pure. Every identity the rows need is resolved here or supplied by the host, so the components
 * stay presentational and this can be tested without a store.
 */

export type ResumeCandidate = {
  sessionId: string
  workspaceId: string
  /** Any agent the host registered; a client without the registered-agents capability gets
   *  only Claude's and Codex's offers. */
  agent: StructuredAgentId
  trigger: 'quit' | 'update'
  latestPrompt: string
  recordedAt: number
  /** Optional on the wire: an older host omits them, and a row must still render. */
  executionHostId?: ExecutionHostId
  workspaceKind?: AgentSessionWorkspaceKind
  model?: string
  /** What the chat was doing, snapshotted by the host as it stopped; an older host omits it. */
  activity?: AgentSessionRestartActivity
}

/** An offer that was acted on and did not end with the agent carrying on. The host keeps it until
 *  the user sends in the chat, retries successfully, dismisses it, or closes the chat. */
export type ResumeFailure = ResumeCandidate & {
  failedAt: number
  outcome: 'refused' | 'unconfirmed'
  /** The host's or provider's refusal code, verbatim; or, for a resume request lost before the
   *  host reserved anything, this side's own `agent_session_restart_request_failed`. */
  reason: string
  /** Whether a retry would run at all; an older host omits it and the reason decides alone. */
  retryable?: boolean
}

export type ResumeWorkspaceGroup = {
  workspaceId: string
  candidates: ResumeCandidate[]
}

export type ResumeRepoGroup = {
  /** The repo these workspaces belong to, or null for workspaces with no repo (folder workspaces). */
  repoId: string | null
  workspaces: ResumeWorkspaceGroup[]
}

/**
 * The same id space automation dispatch resolves: a folder workspace by its full `folder:<uuid>`
 * key, a git worktree by its bare `repoId::path` id.
 */
function isFolderWorkspaceId(workspaceId: string): boolean {
  return parseWorkspaceKey(workspaceId)?.type === 'folder'
}

/**
 * The workspace kind, preferring what the HOST recorded.
 *
 * The host read it off the durable record, which is authoritative; the id shape is the fallback for
 * an older host that sent no kind. Never inferred from a display name.
 */
export function resumeWorkspaceKind(candidate: ResumeCandidate): AgentSessionWorkspaceKind {
  return (
    candidate.workspaceKind ??
    (isFolderWorkspaceId(candidate.workspaceId) ? 'folder' : 'git-worktree')
  )
}

export type ResumeMachineGroup = {
  hostId: ExecutionHostId
  candidates: ResumeCandidate[]
}

/** Groups by the machine each chat runs on, in first-seen order; no host id means this machine. */
export function groupResumeCandidatesByHost(
  candidates: readonly ResumeCandidate[]
): ResumeMachineGroup[] {
  const groups = new Map<ExecutionHostId, ResumeCandidate[]>()
  for (const candidate of candidates) {
    const hostId = candidate.executionHostId ?? LOCAL_EXECUTION_HOST_ID
    const existing = groups.get(hostId)
    if (existing) {
      existing.push(candidate)
    } else {
      groups.set(hostId, [candidate])
    }
  }
  return [...groups].map(([hostId, entries]) => ({ hostId, candidates: entries }))
}

/** Groups by workspace, preserving the order the host offered them so the list is stable. */
export function groupResumeCandidates(
  candidates: readonly ResumeCandidate[]
): ResumeWorkspaceGroup[] {
  const groups = new Map<string, ResumeCandidate[]>()
  for (const candidate of candidates) {
    const existing = groups.get(candidate.workspaceId)
    if (existing) {
      existing.push(candidate)
    } else {
      groups.set(candidate.workspaceId, [candidate])
    }
  }
  return [...groups].map(([workspaceId, entries]) => ({ workspaceId, candidates: entries }))
}

/**
 * Groups the workspaces under the repo each belongs to, in first-seen order.
 *
 * `repoIdFor` comes from the store; workspaces it cannot place collapse into a single `null` group
 * rather than each inventing a header of its own.
 */
export function groupResumeWorkspacesByRepo(
  workspaces: readonly ResumeWorkspaceGroup[],
  repoIdFor: (workspaceId: string) => string | null
): ResumeRepoGroup[] {
  const groups = new Map<string, ResumeRepoGroup>()
  for (const workspace of workspaces) {
    const repoId = repoIdFor(workspace.workspaceId)
    const key = repoId ?? '\0none'
    const existing = groups.get(key)
    if (existing) {
      existing.workspaces.push(workspace)
    } else {
      groups.set(key, { repoId, workspaces: [workspace] })
    }
  }
  return [...groups.values()]
}

export type ResumeWorkspaceNode = {
  group: ResumeWorkspaceGroup
  children: ResumeWorkspaceNode[]
}

/**
 * Nests each workspace under its nearest LISTED ancestor, as the sidebar nests child workspaces.
 *
 * `ancestorsOf` is nearest-first; an ancestor with nothing to resume is skipped, so its listed
 * descendants attach to the next listed one up, or stay at the top. Offer order is kept.
 */
export function nestResumeWorkspaces(
  workspaces: readonly ResumeWorkspaceGroup[],
  ancestorsOf: (workspaceId: string) => readonly string[]
): ResumeWorkspaceNode[] {
  const nodes = new Map<string, ResumeWorkspaceNode>(
    workspaces.map((group) => [group.workspaceId, { group, children: [] }])
  )
  const parentOf = new Map<ResumeWorkspaceNode, ResumeWorkspaceNode>()
  for (const node of nodes.values()) {
    const parentId = ancestorsOf(node.group.workspaceId).find(
      (id) => id !== node.group.workspaceId && nodes.has(id)
    )
    const parent = parentId === undefined ? undefined : nodes.get(parentId)
    if (parent) {
      parentOf.set(node, parent)
    }
  }
  // Why: a loop in the parent chain would leave its members under no root, and a ticked chat that
  // renders nowhere would still be resumed; the loop is cut where the walk first comes back.
  for (const node of nodes.values()) {
    const seen = new Set([node])
    let up = parentOf.get(node)
    while (up && !seen.has(up)) {
      seen.add(up)
      up = parentOf.get(up)
    }
    if (up) {
      parentOf.delete(up)
    }
  }
  const roots: ResumeWorkspaceNode[] = []
  for (const node of nodes.values()) {
    const parent = parentOf.get(node)
    if (parent) {
      parent.children.push(node)
    } else {
      roots.push(node)
    }
  }
  return roots
}

/** A workspace's chats followed by those of every workspace nested under it, in list order. */
export function resumeWorkspaceCandidates(node: ResumeWorkspaceNode): ResumeCandidate[] {
  return [...node.group.candidates, ...node.children.flatMap(resumeWorkspaceCandidates)]
}

export type ResumeSelectionState = {
  checked: boolean | 'indeterminate'
  selectedCount: number
  total: number
}

/** A group checkbox's state over the selectable chats it covers. */
export function resumeSelectionState(
  sessionIds: readonly string[],
  selected: ReadonlySet<string>
): ResumeSelectionState {
  const selectedCount = sessionIds.filter((sessionId) => selected.has(sessionId)).length
  const total = sessionIds.length
  const checked =
    total > 0 && selectedCount === total ? true : selectedCount > 0 ? 'indeterminate' : false
  return { checked, selectedCount, total }
}

/** Ticks every chat a group covers unless all already are, then unticks them. */
export function toggleResumeSelection(
  sessionIds: readonly string[],
  state: ResumeSelectionState,
  onToggle: (sessionId: string, checked: boolean) => void
): void {
  const next = state.selectedCount < state.total
  for (const sessionId of sessionIds) {
    onToggle(sessionId, next)
  }
}

export type ResumeGroupHeader =
  | { kind: 'repo'; name: string; repoIcon: RepoIcon | null }
  | { kind: 'project'; name: string }

/**
 * What the top tier of a group is called, and which glyph it takes.
 *
 * A folder workspace's synthetic worktree carries a `repoId` of `folder-workspace:<projectGroupId>`
 * — NEVER null — so "has no git repo" cannot be detected by testing for absence. Unwrapping the id
 * is the only thing that separates the two, and a project group is then titled by its own name, as
 * the sidebar titles it. Falling back to the raw id would print a uuid at the user.
 */
export function resolveResumeGroupHeader(
  repoId: string | null,
  repos: readonly { id: string; displayName: string; repoIcon?: RepoIcon | null }[],
  projectGroups: readonly { id: string; name: string }[]
): ResumeGroupHeader {
  const projectGroupId = projectGroupIdFromRepoId(repoId)
  if (projectGroupId !== null) {
    const group = projectGroups.find((entry) => entry.id === projectGroupId)
    return { kind: 'project', name: group?.name ?? projectGroupId }
  }
  const repo = repos.find((entry) => entry.id === repoId)
  return {
    kind: 'repo',
    name: repo?.displayName ?? repoId ?? '',
    repoIcon: repo?.repoIcon ?? null
  }
}

/** Every offered session id, which is what an unselective action names. */
export function allResumeSessionIds(candidates: readonly ResumeCandidate[]): string[] {
  return candidates.map((candidate) => candidate.sessionId)
}
