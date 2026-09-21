import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AgentSessionWorkspaceKind } from '../../../shared/agent-session-record'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { projectGroupIdFromRepoId } from '../../../shared/folder-workspace-worktree'
import type { RepoIcon } from '../../../shared/repo-icon'

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
  agent: 'claude' | 'codex'
  trigger: 'quit' | 'update'
  latestPrompt: string
  recordedAt: number
  /** Optional on the wire: an older host omits them, and a row must still render. */
  executionHostId?: ExecutionHostId
  workspaceKind?: AgentSessionWorkspaceKind
  model?: string
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
export function isFolderWorkspaceId(workspaceId: string): boolean {
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

/** Every offered session id, which is the default selection and the ceiling on any selection. */
export function allResumeSessionIds(candidates: readonly ResumeCandidate[]): string[] {
  return candidates.map((candidate) => candidate.sessionId)
}

/**
 * Narrows a selection to sessions the host actually offered.
 *
 * Selection changes only WHICH eligible chats are acted on, never what is eligible, so anything not
 * in the offered set is dropped here before it can reach an action.
 */
export function selectedResumeSessionIds(
  candidates: readonly ResumeCandidate[],
  selected: ReadonlySet<string>
): string[] {
  return candidates
    .filter((candidate) => selected.has(candidate.sessionId))
    .map((candidate) => candidate.sessionId)
}
