import { useMemo } from 'react'
import { Folder, FolderTree, GitBranch, Monitor } from 'lucide-react'
import { RepoIconGlyph } from '@/components/repo/repo-icon'
import { WorktreeHostContextBadge } from '@/components/sidebar/WorktreeHostContextBadge'
import { useSidebarHostScopeOptions } from '@/components/sidebar/use-sidebar-host-scope-options'
import { translate } from '@/i18n/i18n'
import {
  resolveWorktreeBranchLabel,
  resolveWorktreeDisplayName
} from '@/lib/worktree-default-display-name'
import { getHostContextLabel } from '../../../shared/worktree/host-context-labels'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { useAppStore } from '../store'
import {
  useLineageAncestors,
  useRepoIdByWorkspace,
  useWorkspaceWorktree
} from './native-chat-resume-workspace-lookups'
import { ResumeCandidateRow } from './NativeChatResumeOnRestartAgentRow'
import { ResumeTreeCount, ResumeTreeRow } from './NativeChatResumeTreeRow'
import {
  chatState,
  coveredKeys,
  ResumeTreeDepthContext,
  useResumeTreeExpansion,
  type FailureProps,
  type TreeProps
} from './native-chat-resume-tree-state'
import {
  groupResumeCandidates,
  groupResumeCandidatesByHost,
  groupResumeWorkspacesByRepo,
  nestResumeWorkspaces,
  resolveResumeGroupHeader,
  resumeSelectionState,
  resumeWorkspaceKind,
  resumeWorkspaceCandidates,
  toggleResumeSelection,
  type ResumeCandidate,
  type ResumeWorkspaceGroup,
  type ResumeWorkspaceNode
} from './native-chat-resume-on-restart-grouping'

export type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'

/**
 * The offered chats as a tree: machine, then project, then workspace (a child workspace is a node
 * inside its parent, after the parent's chats), then the chats.
 *
 * Every node's checkbox sits in one column at the left edge and covers every selectable chat under
 * it; levels read apart by icon and weight, nesting by indent and the disclosure arrows. The machine
 * level shows only when the machine is not obvious (a remote host, or chats on more than one), and
 * then it is what names the host, so no workspace repeats it.
 *
 * A workspace the store does not know yet (host connecting, or deleted) is named by its id.
 */

/** A group node: its row, then (while open) what is under it. */
function GroupNode({
  nodeKey,
  depth,
  name,
  checkboxLabel,
  covered,
  tree,
  label,
  children
}: {
  nodeKey: string
  depth: number
  name: string
  checkboxLabel: string
  /** Every selectable chat under this node. */
  covered: readonly string[]
  tree: TreeProps
  label: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  const selection = resumeSelectionState(covered, tree.selected)
  const expanded = tree.isExpanded(nodeKey)
  return (
    <>
      <ResumeTreeRow
        depth={depth}
        expanded={expanded}
        onExpandedChange={(next) => tree.setExpanded(nodeKey, next)}
        name={name}
        checked={selection.checked}
        disabled={tree.busy || selection.total === 0}
        onCheckedChange={() => toggleResumeSelection(covered, selection, tree.onToggle)}
        checkboxLabel={checkboxLabel}
      >
        {label}
        <ResumeTreeCount selectedCount={selection.selectedCount} total={selection.total} />
      </ResumeTreeRow>
      {/* Collapsing unmounts the rows only; their selection lives with the dialog. */}
      {expanded && children}
    </>
  )
}

function WorkspaceNode({
  node,
  hostId,
  depth,
  tree
}: {
  node: ResumeWorkspaceNode
  hostId: ExecutionHostId
  depth: number
  tree: TreeProps
}): React.JSX.Element {
  const { group } = node
  const first = group.candidates[0]
  const worktree = useWorkspaceWorktree(group.workspaceId, first?.executionHostId)
  const kind = first ? resumeWorkspaceKind(first) : 'git-worktree'
  // Kind comes from the host's record, never from a name.
  const KindGlyph = kind === 'folder' ? Folder : GitBranch
  const name = (worktree && resolveWorktreeDisplayName(worktree)) || group.workspaceId
  const branch = worktree && kind === 'git-worktree' ? resolveWorktreeBranchLabel(worktree) : ''
  return (
    <GroupNode
      nodeKey={`workspace:${hostId}:${group.workspaceId}`}
      depth={depth}
      name={name}
      checkboxLabel={translate(
        'auto.components.NativeChatResumeOnRestartModal.selectWorkspace',
        'Select all chats in {{value0}}',
        { value0: name }
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
              workspaceName={name}
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
        />
      ))}
    </GroupNode>
  )
}

/**
 * A git repo, or the project group a folder workspace belongs to.
 *
 * A folder workspace's synthetic worktree carries `repoId` of `folder-workspace:<projectGroupId>` —
 * never null — so "no repo" cannot be detected by testing for absence. `projectGroupIdFromRepoId`
 * is the only thing that separates the two, and the sidebar likewise titles these with the project
 * group's name.
 */
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
  const repos = useAppStore((store) => store.repos)
  const projectGroups = useAppStore((store) => store.projectGroups)
  const header = resolveResumeGroupHeader(repoId, repos, projectGroups)
  return (
    <GroupNode
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
          {/* A repo shows its own configured glyph; a project group uses the FolderTree the
              sidebar's own PROJECT_GROUP_META uses. */}
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
    </GroupNode>
  )
}

/** A machine's projects, each a node; workspaces the store cannot place sit at project depth. */
function MachineContents({
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
  const byId = new Map(workspaces.map((group) => [group.workspaceId, group]))
  const lookup =
    <T,>(read: (group: ResumeWorkspaceGroup) => T, fallback: T) =>
    (id: string) => {
      const group = byId.get(id)
      return group ? read(group) : fallback
    }
  const ancestorsOf = lookup(tree.ancestorsOf, [])
  return (
    <>
      {groupResumeWorkspacesByRepo(workspaces, lookup(tree.repoIdOf, null)).map((repoGroup) => {
        const nodes = nestResumeWorkspaces(repoGroup.workspaces, ancestorsOf)
        // A group the store cannot place has no project to name or select; Select all covers it.
        return repoGroup.repoId === null ? (
          nodes.map((node) => (
            <WorkspaceNode
              key={node.group.workspaceId}
              node={node}
              hostId={hostId}
              depth={depth}
              tree={tree}
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
      })}
    </>
  )
}

function MachineNode({
  hostId,
  candidates,
  workspaces,
  hostLabelById,
  tree
}: {
  hostId: ExecutionHostId
  candidates: readonly ResumeCandidate[]
  workspaces: readonly ResumeWorkspaceGroup[]
  hostLabelById: ReadonlyMap<ExecutionHostId, string>
  tree: TreeProps
}): React.JSX.Element {
  const name = getHostContextLabel(hostId, { hostLabelById })
  return (
    <GroupNode
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
    </GroupNode>
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
  selectableIds
}: {
  candidates: readonly ResumeCandidate[]
  listedAt: number
  busy: boolean
  selected: ReadonlySet<string>
  onToggle: (sessionId: string, checked: boolean) => void
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
  const { hostOptions } = useSidebarHostScopeOptions()
  const hostLabelById = useMemo(
    () => new Map(hostOptions.map((host) => [host.id, host.label])),
    [hostOptions]
  )
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
  // Why: the machine is worth a level only when it is not obvious.
  const showMachines =
    machines.length > 1 || machines.some((machine) => machine.hostId !== LOCAL_EXECUTION_HOST_ID)
  return (
    <div className="flex flex-col">
      {machines.map((machine) =>
        showMachines ? (
          <MachineNode
            key={machine.hostId}
            hostId={machine.hostId}
            candidates={machine.candidates}
            workspaces={machine.workspaces}
            hostLabelById={hostLabelById}
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
  )
}
