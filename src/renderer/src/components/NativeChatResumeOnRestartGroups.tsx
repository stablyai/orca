import { getIndexedRepoHostMap, getIndexedRepoMap } from '@/store/worktree-repo-index'
import { findIndexedProjectGroupDisplay } from '@/lib/worktree-runtime-owner-index'
import { projectGroupIdFromRepoId } from '../../../shared/folder-workspace-worktree'
import { memo, useMemo } from 'react'
import { Folder, FolderTree, GitBranch, Monitor } from 'lucide-react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { ProjectOptionDetail } from '@/components/new-workspace/ProjectComboboxRow'
import { WorktreeHostContextBadge } from '@/components/sidebar/WorktreeHostContextBadge'
import { useSidebarHostScopeOptions } from '@/components/sidebar/use-sidebar-host-scope-options'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeBranchLabel } from '@/lib/worktree-default-display-name'
import { getHostContextLabel } from '../../../shared/worktree/host-context-labels'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { useAppStore } from '../store'
import { useResumeProjectGroupKeys } from './use-resume-project-group-keys'
import * as workspaceDisplay from './native-chat-resume-workspace-display'
import {
  useLineageAncestors,
  useRepoIdByWorkspace,
  useWorkspaceWorktree
} from './native-chat-resume-workspace-lookups'
import { ResumeCandidateRow } from './NativeChatResumeOnRestartAgentRow'
import { ResumeTreeGroup } from './NativeChatResumeTreeGroup'
import {
  chatState,
  coveredKeys,
  ResumeTreeDepthContext,
  ResumeTreeSelectingContext,
  useResumeTreeExpansion,
  type FailureProps,
  type TreeProps
} from './native-chat-resume-tree-state'
import {
  groupResumeCandidates,
  groupResumeCandidatesByHost,
  groupResumeWorkspacesByRepo,
  resumeWorkspaceLookup,
  nestResumeWorkspaces,
  resolveResumeGroupHeader,
  resumeWorkspaceKind,
  resumeWorkspaceCandidates,
  type ResumeCandidate,
  type ResumeWorkspaceGroup,
  type ResumeWorkspaceNode
} from './native-chat-resume-on-restart-grouping'

export type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/** Group by machine/project/workspace/chat, nesting child workspaces after parent chats. Show machine nodes for remote/multiple hosts; name unknown workspaces by their encoded folder. */

function WorkspaceNode({
  node,
  hostId,
  depth,
  tree,
  fallbackDisplays
}: {
  node: ResumeWorkspaceNode
  hostId: ExecutionHostId
  depth: number
  tree: TreeProps
  fallbackDisplays?: workspaceDisplay.WorkspaceFallbacks
}): React.JSX.Element {
  const { group } = node
  const first = group.candidates[0]
  const worktree = useWorkspaceWorktree(group.workspaceId, first?.executionHostId)
  const kind = first ? resumeWorkspaceKind(first) : 'git-worktree'
  // Kind comes from the host's record, never from a name.
  const KindGlyph = kind === 'folder' ? Folder : GitBranch
  const fallback = fallbackDisplays?.get(group)
  const { name, controlName } = workspaceDisplay.resolveNames(worktree, fallback, group.workspaceId)
  const branch = worktree && kind === 'git-worktree' ? resolveWorktreeBranchLabel(worktree) : ''
  return (
    <ResumeTreeGroup
      nodeKey={`workspace:${hostId}:${group.workspaceId}`}
      depth={depth}
      name={controlName}
      checkboxLabel={translate(
        'auto.components.NativeChatResumeOnRestartModal.selectWorkspace',
        'Select all chats in {{value0}}',
        { value0: controlName }
      )}
      covered={coveredKeys(resumeWorkspaceCandidates(node), tree)}
      tree={tree}
      label={
        <>
          <KindGlyph className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{name}</span>
          {branch && (
            <span className="min-w-0 shrink-2 truncate text-[11px] text-muted-foreground">
              {branch}
            </span>
          )}
          {!worktree && fallback?.parentPath && (
            <ProjectOptionDetail
              detail={fallback.parentPath}
              className="shrink-2 text-[11px] text-muted-foreground"
            />
          )}
        </>
      }
    >
      <ResumeTreeDepthContext.Provider value={depth + 1}>
        {group.candidates.map((candidate) => {
          const chat = chatState(candidate, tree)
          return (
            <ResumeCandidateRow
              key={chat.key}
              candidate={candidate}
              workspaceName={controlName}
              listedAt={tree.listedAt}
              checked={chat.checked}
              disabled={tree.busy}
              onCheckedChange={chat.onCheckedChange}
              failure={chat.failure}
              onFailureAction={tree.onFailureAction}
              renderStatus={chat.renderStatus}
            />
          )
        })}
      </ResumeTreeDepthContext.Provider>
      {node.children.map((child) => (
        <WorkspaceNode
          key={child.group.workspaceId}
          node={child}
          hostId={hostId}
          depth={depth + 1}
          tree={tree}
          fallbackDisplays={fallbackDisplays}
        />
      ))}
    </ResumeTreeGroup>
  )
}

/** Folder workspaces have synthetic folder-workspace:<projectGroupId> repo IDs. Decode with projectGroupIdFromRepoId; absence alone cannot distinguish them from Git repos. */
function ProjectNode({
  repoId,
  hostId,
  workspaces,
  depth,
  tree
}: {
  repoId: string
  hostId: ExecutionHostId
  workspaces: readonly ResumeWorkspaceNode[]
  depth: number
  tree: TreeProps
}): React.JSX.Element {
  const repo = useAppStore(
    (store) =>
      getIndexedRepoHostMap(store.repos).get(`${hostId}\0${repoId}`) ??
      getIndexedRepoMap(store.repos).get(repoId)
  )
  const projectGroupId = projectGroupIdFromRepoId(repoId)
  const projectGroup = useAppStore((store) =>
    projectGroupId === null
      ? undefined
      : findIndexedProjectGroupDisplay(store.projectGroups, projectGroupId)
  )
  const header = resolveResumeGroupHeader(
    repoId,
    repo ? [repo] : [],
    projectGroup ? [projectGroup] : []
  )
  return (
    <ResumeTreeGroup
      nodeKey={`project:${hostId}:${repoId}`}
      depth={depth}
      name={header.name}
      checkboxLabel={translate(
        'auto.components.NativeChatResumeOnRestartModal.selectProject',
        'Select all chats in {{value0}}',
        { value0: header.name }
      )}
      covered={coveredKeys(workspaces.flatMap(resumeWorkspaceCandidates), tree)}
      tree={tree}
      label={
        <>
          {/* Match the sidebar’s configured repo glyph or project-group FolderTree. */}
          {header.kind === 'project' ? (
            <FolderTree className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          ) : (
            <RepoIconGlyph
              repoIcon={header.repoIcon}
              className="size-3.5 text-muted-foreground"
              iconClassName="size-3.5"
            />
          )}
          <span className="min-w-0 truncate text-[13px] font-semibold">{header.name}</span>
        </>
      }
    >
      {workspaces.map((node) => (
        <WorkspaceNode
          key={node.group.workspaceId}
          node={node}
          hostId={hostId}
          depth={depth + 1}
          tree={tree}
        />
      ))}
    </ResumeTreeGroup>
  )
}

/** A machine's projects, each a node; workspaces the store cannot place sit at project depth. */
const MachineContents = memo(function MachineContents({
  hostId,
  workspaces,
  depth,
  tree
}: {
  hostId: ExecutionHostId
  workspaces: readonly ResumeWorkspaceGroup[]
  depth: number
  tree: TreeProps
}): React.JSX.Element {
  const lookup = resumeWorkspaceLookup(workspaces)
  const repoIdFor = useMemo(
    () => resumeWorkspaceLookup(workspaces)(tree.repoIdOf, null),
    [workspaces, tree.repoIdOf]
  )
  const groupKeys = useResumeProjectGroupKeys(hostId, workspaces, repoIdFor)
  const ancestorsOf = lookup(tree.ancestorsOf, [])
  return (
    <>
      {groupResumeWorkspacesByRepo(workspaces, repoIdFor, [], undefined, undefined, groupKeys).map(
        (repoGroup) => {
          const nodes = nestResumeWorkspaces(repoGroup.workspaces, ancestorsOf)
          const fallbackDisplays = workspaceDisplay.deriveFallbacks(repoGroup)
          // A group the store cannot place has no project to name or select; Select all covers it.
          return repoGroup.repoId === null ? (
            nodes.map((node) => (
              <WorkspaceNode
                key={node.group.workspaceId}
                node={node}
                hostId={hostId}
                depth={depth}
                tree={tree}
                fallbackDisplays={fallbackDisplays}
              />
            ))
          ) : (
            <ProjectNode
              key={repoGroup.repoId}
              repoId={repoGroup.repoId}
              hostId={hostId}
              workspaces={nodes}
              depth={depth}
              tree={tree}
            />
          )
        }
      )}
    </>
  )
})

function MachineNode({
  hostId,
  candidates,
  workspaces,
  tree
}: {
  hostId: ExecutionHostId
  candidates: readonly ResumeCandidate[]
  workspaces: readonly ResumeWorkspaceGroup[]
  tree: TreeProps
}): React.JSX.Element {
  const { hostOptions } = useSidebarHostScopeOptions()
  const hostLabelById = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, host.label])),
    [hostOptions]
  )
  const name = getHostContextLabel(hostId, { hostLabelById })
  return (
    <ResumeTreeGroup
      nodeKey={`machine:${hostId}`}
      depth={0}
      name={name}
      checkboxLabel={translate(
        'auto.components.NativeChatResumeOnRestartModal.selectMachine',
        'Select all chats on {{value0}}',
        { value0: name }
      )}
      covered={coveredKeys(candidates, tree)}
      tree={tree}
      label={
        <>
          <Monitor className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="min-w-0 truncate text-[13px] font-bold">{name}</span>
          {parseExecutionHostId(hostId)?.kind === 'ssh' && (
            <WorktreeHostContextBadge
              label={translate('auto.components.NativeChatResumeOnRestartModal.sshHost', 'SSH')}
            />
          )}
        </>
      }
    >
      <MachineContents hostId={hostId} workspaces={workspaces} depth={1} tree={tree} />
    </ResumeTreeGroup>
  )
}

export function ResumeOnRestartGroups({
  candidates,
  listedAt,
  busy,
  selected,
  onToggle,
  failureFor,
  onFailureAction,
  renderStatus,
  selectableIds,
  selecting = true
}: {
  candidates: readonly ResumeCandidate[]
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
  /** False once every chat shows a run status, so no checkbox is left to act on. */
  selecting?: boolean
} & FailureProps): React.JSX.Element {
  const machines = useMemo(
    () =>
      groupResumeCandidatesByHost(candidates).map((machine) => ({
        ...machine,
        workspaces: groupResumeCandidates(machine.candidates)
      })),
    [candidates]
  )
  const allWorkspaces = useMemo(() => machines.flatMap((machine) => machine.workspaces), [machines])
  const repoIdOf = useRepoIdByWorkspace(allWorkspaces)
  const ancestorsOf = useLineageAncestors(allWorkspaces)
  const expansion = useResumeTreeExpansion()
  const tree: TreeProps = {
    listedAt,
    busy,
    selected,
    onToggle,
    ...expansion,
    repoIdOf,
    ancestorsOf,
    failureFor,
    onFailureAction,
    renderStatus,
    selectableIds
  }
  // Only remote/multiple hosts need an explicit machine level.
  const showMachines =
    machines.length > 1 || machines.some((machine) => machine.hostId !== LOCAL_EXECUTION_HOST_ID)
  return (
    <ResumeTreeSelectingContext.Provider value={selecting}>
      <div className="flex flex-col">
        {machines.map((machine) =>
          showMachines ? (
            <MachineNode
              key={machine.hostId}
              hostId={machine.hostId}
              candidates={machine.candidates}
              workspaces={machine.workspaces}
              tree={tree}
            />
          ) : (
            <MachineContents
              key={machine.hostId}
              hostId={machine.hostId}
              workspaces={machine.workspaces}
              depth={0}
              tree={tree}
            />
          )
        )}
      </div>
    </ResumeTreeSelectingContext.Provider>
  )
}
