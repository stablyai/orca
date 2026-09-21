import { Folder, FolderTree, GitBranch } from 'lucide-react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { WorktreeHostContextBadge } from '@/components/sidebar/WorktreeHostContextBadge'
import { getHostContextLabel } from '../../../shared/worktree/host-context-labels'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { AgentSessionWorkspaceKind } from '../../../shared/agent-session-record'
import { useAppStore } from '../store'
import { ResumeCandidateRow } from './NativeChatResumeOnRestartAgentRow'
import {
  groupResumeCandidates,
  groupResumeWorkspacesByRepo,
  resolveResumeGroupHeader,
  resumeWorkspaceKind,
  type ResumeCandidate,
  type ResumeWorkspaceGroup
} from './native-chat-resume-on-restart-grouping'

export type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/**
 * The offered chats in the sidebar's three tiers: repo/project, then workspace, then agent sessions.
 *
 * Reused from the sidebar rather than rebuilt: `RepoIconGlyph` for a repo's own glyph, `FolderTree`
 * from the sidebar's `PROJECT_GROUP_META` for a project group, and `WorktreeHostContextBadge` —
 * extracted from the sidebar card's meta row so both surfaces render one chip. The label inside it
 * comes from `getHostContextLabel`, which is the sidebar's own source for "Local Mac".
 *
 * The sidebar has NO resolver for git-worktree vs folder-workspace glyphs: both kinds render the
 * same card, and the apparent difference is its status lane picking `GitBranch` when the workspace
 * has a branch identity. That single sidebar precedent is what the workspace glyph follows here.
 */

type StoreState = ReturnType<typeof useAppStore.getState>

function resolveWorkspaceWorktree(store: StoreState, workspaceId: string) {
  return (
    store.getKnownWorktreeById(workspaceId) ??
    store.allWorktrees().find((entry) => entry.id === workspaceId)
  )
}

/** Selectors return primitives, so repeated runs cannot churn equality. */
function useWorkspaceName(workspaceId: string): string {
  return useAppStore(
    (store) => resolveWorkspaceWorktree(store, workspaceId)?.displayName ?? workspaceId
  )
}

/**
 * The repo owning each workspace, as one narrow subscription.
 *
 * Selected as a joined string rather than a map so the selector returns a PRIMITIVE: a fresh object
 * or array would fail the equality check on every store change and re-render the whole list.
 */
function useRepoIdByWorkspace(
  workspaceIds: readonly string[]
): (workspaceId: string) => string | null {
  const key = workspaceIds.join('\0')
  const joined = useAppStore((store) =>
    key
      .split('\0')
      .map((id) => resolveWorkspaceWorktree(store, id)?.repoId ?? '')
      .join('\0')
  )
  const repoIds = joined.split('\0')
  return (workspaceId: string) => {
    const index = workspaceIds.indexOf(workspaceId)
    const repoId = index === -1 ? '' : (repoIds[index] ?? '')
    return repoId === '' ? null : repoId
  }
}

/** The glyph for the workspace itself. Kind comes from the host's record, never from a name. */
function WorkspaceKindGlyph({ kind }: { kind: AgentSessionWorkspaceKind }): React.JSX.Element {
  return kind === 'folder' ? (
    <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  ) : (
    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
  )
}

/**
 * The top tier: a git repo, or the project group a folder workspace belongs to.
 *
 * A folder workspace's synthetic worktree carries `repoId` of `folder-workspace:<projectGroupId>` —
 * never null — so "no repo" cannot be detected by testing for absence. `projectGroupIdFromRepoId`
 * is the only thing that separates the two, and the sidebar likewise titles these with the project
 * group's name.
 */
function RepoHeader({ repoId }: { repoId: string | null }): React.JSX.Element {
  const repos = useAppStore((store) => store.repos)
  const projectGroups = useAppStore((store) => store.projectGroups)
  const header = resolveResumeGroupHeader(repoId, repos, projectGroups)
  return (
    <div className="flex items-center gap-1.5 px-0.5">
      {/* A repo shows its own configured glyph; a project group uses the FolderTree the sidebar's
          own PROJECT_GROUP_META uses. */}
      {header.kind === 'project' ? (
        <FolderTree className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <RepoIconGlyph repoIcon={header.repoIcon} className="size-3.5" iconClassName="size-3.5" />
      )}
      <span className="min-w-0 flex-1 truncate text-xs font-semibold">{header.name}</span>
    </div>
  )
}

function WorkspaceGroup({
  group,
  listedAt,
  busy,
  selected,
  onToggle
}: {
  group: ResumeWorkspaceGroup
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
}): React.JSX.Element {
  const name = useWorkspaceName(group.workspaceId)
  const first = group.candidates[0]
  const kind = first ? resumeWorkspaceKind(first) : 'git-worktree'
  // Shown for every workspace, local included. The sidebar hides it on a single-host install; this
  // list is a one-off prompt with no surrounding context, so the machine is always worth naming.
  const hostLabel = getHostContextLabel(first?.executionHostId ?? LOCAL_EXECUTION_HOST_ID)
  return (
    <section className="flex flex-col gap-0.5">
      <div className="flex items-center gap-1.5 px-0.5">
        <WorkspaceKindGlyph kind={kind} />
        <span className="min-w-0 truncate text-xs font-medium">{name}</span>
        <WorktreeHostContextBadge label={hostLabel} />
      </div>
      <ul className="flex flex-col pl-1">
        {group.candidates.map((candidate) => (
          <ResumeCandidateRow
            key={candidate.sessionId}
            candidate={candidate}
            workspaceName={name}
            listedAt={listedAt}
            checked={selected.has(candidate.sessionId)}
            disabled={busy}
            onCheckedChange={(checked) => onToggle(candidate.sessionId, checked)}
          />
        ))}
      </ul>
    </section>
  )
}

export function ResumeOnRestartGroups({
  candidates,
  listedAt,
  busy,
  selected,
  onToggle
}: {
  candidates: ResumeCandidate[]
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
}): React.JSX.Element {
  const workspaces = groupResumeCandidates(candidates)
  const repoIdFor = useRepoIdByWorkspace(workspaces.map((group) => group.workspaceId))
  const repoGroups = groupResumeWorkspacesByRepo(workspaces, repoIdFor)
  return (
    <div className="flex flex-col gap-2.5">
      {repoGroups.map((repoGroup) => (
        <section key={repoGroup.repoId ?? 'no-repo'} className="flex flex-col gap-1">
          <RepoHeader repoId={repoGroup.repoId} />
          <div className="flex flex-col gap-1.5 pl-2">
            {repoGroup.workspaces.map((workspace) => (
              <WorkspaceGroup
                key={workspace.workspaceId}
                group={workspace}
                listedAt={listedAt}
                busy={busy}
                selected={selected}
                onToggle={onToggle}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}
