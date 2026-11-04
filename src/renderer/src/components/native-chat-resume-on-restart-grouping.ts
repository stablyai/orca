import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AgentSessionWorkspaceKind } from '../../../shared/agent-session/lifecycle/agent-session-record'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../../../shared/execution-host'
import { composeWorktreeHostIdentity } from '../../../shared/worktree/host-qualified-identity'
import { projectGroupIdFromRepoId } from '../../../shared/folder-workspaces/folder-workspace-worktree'
import type { RepoIcon } from '../../../shared/repo-icon'
import type { AgentSessionRestartActivity } from '../../../shared/agent-session/lifecycle/agent-session-restart-activity'
import type { StructuredAgentId } from '../../../shared/agent-session/lifecycle/agent-session-provider-handle'

export type ResumeCandidate = {
  sessionId: string
  workspaceId: string
  /** Older clients without registered-agent support receive only Claude/Codex offers. */
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

/** Keep refused/unconfirmed offers until manual continuation, successful retry, dismissal or chat closure. */
export type ResumeFailure = ResumeCandidate & {
  failedAt: number
  outcome: 'refused' | 'unconfirmed'
  /** Preserve host/provider reason codes; use agent_session_restart_request_failed for locally lost requests. */
  reason: string
  /** Whether a retry would run at all; an older host omits it and the reason decides alone. */
  retryable?: boolean
}

export type ResumeWorkspaceGroup = {
  workspaceId: string
  candidates: ResumeCandidate[]
}

export type ResumeRepoGroup = {
  /** Repository id, synthetic folder-workspace:<projectGroupId>, or null when no owner is known. */
  repoId: string | null
  workspaces: ResumeWorkspaceGroup[]
}

function isFolderWorkspaceId(workspaceId: string): boolean {
  return parseWorkspaceKey(workspaceId)?.type === 'folder'
}

/** Prefer the host’s durable workspace kind; only older metadata needs an id-namespace fallback. */
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

export function resumeWorkspaceHostId(group: ResumeWorkspaceGroup): ExecutionHostId {
  return group.candidates[0]?.executionHostId ?? LOCAL_EXECUTION_HOST_ID
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

/** Group by owner in first-seen order; unresolved workspaces share one null group. */
export function groupResumeWorkspacesByRepo(
  workspaces: readonly ResumeWorkspaceGroup[],
  repoIdFor: (group: ResumeWorkspaceGroup) => string | null
): ResumeRepoGroup[] {
  const groups = new Map<string, ResumeRepoGroup>()
  for (const workspace of workspaces) {
    const repoId = repoIdFor(workspace)
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

/** Nest under the nearest listed ancestor, skipping ancestors without offers and preserving offer order. */
export function nestResumeWorkspaces(
  workspaces: readonly ResumeWorkspaceGroup[],
  ancestorsOf: (key: string) => readonly string[],
  keyOf: (group: ResumeWorkspaceGroup) => string = (group) => group.workspaceId,
  canNest: (child: ResumeWorkspaceGroup, parent: ResumeWorkspaceGroup) => boolean = () => true
): ResumeWorkspaceNode[] {
  const nodes = new Map<string, ResumeWorkspaceNode>(
    workspaces.map((group) => [keyOf(group), { group, children: [] }])
  )
  const parentOf = new Map<ResumeWorkspaceNode, ResumeWorkspaceNode>()
  for (const [key, node] of nodes) {
    const parentId = ancestorsOf(key).find((id) => {
      const candidate = id === key ? undefined : nodes.get(id)
      return candidate !== undefined && canNest(node.group, candidate.group)
    })
    const parent = parentId === undefined ? undefined : nodes.get(parentId)
    if (parent) {
      parentOf.set(node, parent)
    }
  }
  // Cut lineage cycles so selected chats cannot hide beneath a tree with no root and resume unseen.
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

/** The offer's own machine and workspace; never a catalog row, so twins on two machines stay apart. */
export function resumeWorkspaceKey(group: ResumeWorkspaceGroup): string {
  return composeWorktreeHostIdentity(resumeWorkspaceHostId(group), group.workspaceId)
}

export type ResumeMachineSection = {
  hostId: ExecutionHostId
  projects: { repoGroup: ResumeRepoGroup; roots: ResumeWorkspaceNode[] }[]
}

/** Per-machine, per-project nesting; only a parent on another machine (a cross-store link) pulls a child out of its own section. */
export function nestResumeMachines(
  machines: readonly { hostId: ExecutionHostId; workspaces: readonly ResumeWorkspaceGroup[] }[],
  ancestorsOf: (key: string) => readonly string[],
  repoIdOf: (group: ResumeWorkspaceGroup) => string | null
): ResumeMachineSection[] {
  const roots = nestResumeWorkspaces(
    machines.flatMap((machine) => machine.workspaces),
    ancestorsOf,
    resumeWorkspaceKey,
    (child, parent) =>
      resumeWorkspaceHostId(child) !== resumeWorkspaceHostId(parent) ||
      repoIdOf(child) === repoIdOf(parent)
  )
  return machines
    .map((machine) => ({
      hostId: machine.hostId,
      projects: groupResumeWorkspacesByRepo(machine.workspaces, repoIdOf)
        .map((repoGroup) => ({
          repoGroup,
          roots: roots.filter((root) => repoGroup.workspaces.includes(root.group))
        }))
        .filter((project) => project.roots.length > 0)
    }))
    .filter((section) => section.projects.length > 0)
}

export function resumeWorkspaceCandidates(node: ResumeWorkspaceNode): ResumeCandidate[] {
  return [...node.group.candidates, ...node.children.flatMap(resumeWorkspaceCandidates)]
}

export type ResumeSelectionState = {
  checked: boolean | 'indeterminate'
  selectedCount: number
  total: number
}

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

/** Resolve synthetic folder repoIds through project-group names; non-null repoId does not prove a git repository. */
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

export function allResumeSessionIds(candidates: readonly ResumeCandidate[]): string[] {
  return candidates.map((candidate) => candidate.sessionId)
}
