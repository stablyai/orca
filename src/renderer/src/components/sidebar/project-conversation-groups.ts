import { toAiVaultProjectKey } from '../../../../shared/ai-vault-project-key'
import { createConversationWorkspaceMatcher } from '../../../../shared/conversation-workspace-matcher'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import {
  folderGroupKey,
  type AiVaultSessionProject
} from '../../../../shared/ai-vault-session-filters'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import {
  folderWorkspaceToWorktree,
  getFolderWorkspaceWorktreeHostId
} from '../../../../shared/folder-workspace-worktree'
import type { ProjectHostSetupProjection } from '../../../../shared/project-host-setup-projection'
import type { ProjectOrderBy, ManualRepoOrderEntry } from '../../../../shared/ui-chrome-types'
import {
  getRepoExecutionHostId,
  getExecutionHostLabel,
  normalizeExecutionHostId,
  type ExecutionHostId,
  type ExecutionHostScope
} from '../../../../shared/execution-host'
import { applyManualRepoOrder } from '../../../../shared/manual-repo-order'
import {
  buildProjectGroupingIndex,
  buildProjectSections,
  getProjectGroupingForRepo,
  type ProjectSectionEntry
} from '../../../../shared/project-section-grouping'
import { sortProjectEntries } from '../../../../shared/project-section-order'

type ConversationItem = { session: AiVaultSession; repo: Repo; lastActivityAt?: number }
export type ConversationProjectGroup = {
  key: string
  label: string
  sessions: AiVaultSession[]
  repo?: Repo
  repoIds: Set<string>
  workspaceId?: string
  executionHostId: ExecutionHostId
}
export function buildConversationProjectGroups(args: {
  sessions: readonly AiVaultSession[]
  sessionProjects: ReadonlyMap<string, AiVaultSessionProject>
  repos: readonly Repo[]
  worktrees: readonly Worktree[]
  folders?: readonly FolderWorkspace[]
  catalog: ProjectHostSetupProjection
  order: ProjectOrderBy
  manualOrder?: ManualRepoOrderEntry[]
  activeWorkspaceId: string | null
  activeExecutionHostId?: ExecutionHostId | null
  executionHostScope?: ExecutionHostScope
}): ConversationProjectGroup[] {
  const matchesHost = (host: ExecutionHostId): boolean =>
    !args.executionHostScope ||
    args.executionHostScope === 'all' ||
    args.executionHostScope === host
  const orderedRepos = applyManualRepoOrder(args.repos, args.manualOrder)
  const repoHosts = new Map<string, Set<ExecutionHostId>>()
  const reposByHost = new Map<ExecutionHostId, Repo[]>()
  for (const repo of orderedRepos) {
    const host = getRepoExecutionHostId(repo)
    const hosts = repoHosts.get(repo.id) ?? new Set<ExecutionHostId>()
    hosts.add(host)
    repoHosts.set(repo.id, hosts)
    if (matchesHost(host)) {
      reposByHost.set(host, [...(reposByHost.get(host) ?? []), repo])
    }
  }
  const workspaceHost = (workspace: Worktree): ExecutionHostId | null => {
    const explicit = normalizeExecutionHostId(workspace.hostId)
    if (explicit) {
      return explicit
    }
    const hosts = repoHosts.get(workspace.repoId)
    return hosts?.size === 1 ? [...hosts][0]! : null
  }
  const projectIndex = buildProjectGroupingIndex({
    projects: args.catalog.projects,
    projectHostSetups: args.catalog.setups
  })
  const repoOrder = new Map(orderedRepos.map((repo, index) => [repo.id, index]))
  const assigned = new Set<string>()
  const entries: [string, ProjectSectionEntry<ConversationItem>][] = []
  const hostByKey = new Map<string, ExecutionHostId>()
  for (const [host, repos] of reposByHost) {
    const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
    const reposByProject = new Map<string, Repo[]>()
    for (const repo of repos) {
      const grouping = getProjectGroupingForRepo(repo.id, repoMap, projectIndex)
      for (const key of new Set([grouping.key, toAiVaultProjectKey(grouping.projectId, repo.id)])) {
        if (key) {
          reposByProject.set(key, [...(reposByProject.get(key) ?? []), repo])
        }
      }
    }
    const items = args.sessions.flatMap((session): ConversationItem[] => {
      if (session.executionHostId !== host) {
        return []
      }
      const project = args.sessionProjects.get(session.id)
      const candidates = project?.kind === 'repo' ? reposByProject.get(project.key) : undefined
      const repo = project?.repoId
        ? repoMap.get(project.repoId)
        : candidates?.length &&
            candidates.every(
              (candidate) =>
                getProjectGroupingForRepo(candidate.id, repoMap, projectIndex).key ===
                getProjectGroupingForRepo(candidates[0]!.id, repoMap, projectIndex).key
            )
          ? candidates[0]
          : undefined
      if (!repo) {
        return []
      }
      assigned.add(session.id)
      return [
        {
          session,
          repo,
          lastActivityAt: Date.parse(session.updatedAt ?? session.modifiedAt) || undefined
        }
      ]
    })
    const scopedIndex = projectIndex
      ? {
          ...projectIndex,
          setupByRepoId: new Map(
            args.catalog.setups
              .filter((setup) => setup.hostId === host)
              .map((setup) => [setup.repoId, setup])
          )
        }
      : null
    for (const [key, section] of buildProjectSections({
      items,
      repoIdOf: (item) => item.repo.id,
      repoMap,
      projectIndex: scopedIndex,
      placeholderRepoIds: repoMap.keys(),
      repoOrder,
      projectOrderBy: args.order
    })) {
      const qualifiedKey = JSON.stringify([host, key])
      hostByKey.set(qualifiedKey, host)
      entries.push([qualifiedKey, section])
    }
  }
  const groups: ConversationProjectGroup[] = sortProjectEntries(entries, args.order, repoOrder).map(
    ([key, section]) => {
      const executionHostId = hostByKey.get(key)!
      const workspaces = args.worktrees.filter(
        (workspace) =>
          section.repoIds.has(workspace.repoId) &&
          !workspace.isArchived &&
          workspaceHost(workspace) === executionHostId
      )
      const active =
        args.activeExecutionHostId === executionHostId
          ? workspaces.find((workspace) => workspace.id === args.activeWorkspaceId)
          : undefined
      const target =
        active ?? workspaces.find((workspace) => workspace.isMainWorktree) ?? workspaces[0]
      return {
        key,
        label: section.label,
        sessions: section.items.map((item) => item.session),
        repo: section.repo,
        repoIds: section.repoIds,
        workspaceId: target?.id,
        executionHostId
      }
    }
  )
  const folderGroups = new Map<string, ConversationProjectGroup>()
  const foldersByPath = new Map<string, ConversationProjectGroup[]>()
  for (const folder of args.folders ?? []) {
    const executionHostId = getFolderWorkspaceWorktreeHostId(folder)
    if (folder.isArchived || !matchesHost(executionHostId)) {
      continue
    }
    const workspace = folderWorkspaceToWorktree(folder)
    const key = JSON.stringify([executionHostId, workspace.id])
    const group: ConversationProjectGroup = {
      key,
      label: folder.name,
      sessions: [],
      repoIds: new Set(),
      workspaceId: workspace.id,
      executionHostId
    }
    folderGroups.set(key, group)
    const pathKey = JSON.stringify([executionHostId, folderGroupKey(folder.folderPath)])
    foldersByPath.set(pathKey, [...(foldersByPath.get(pathKey) ?? []), group])
  }
  const matchFolder = createConversationWorkspaceMatcher(
    (args.folders ?? []).filter((folder) => !folder.isArchived).map(folderWorkspaceToWorktree)
  )
  const orphans = new Map<string, ConversationProjectGroup>()
  for (const session of args.sessions) {
    if (assigned.has(session.id) || !matchesHost(session.executionHostId)) {
      continue
    }
    const project = args.sessionProjects.get(session.id)
    const owned = session.structuredSession
      ? folderGroups.get(
          JSON.stringify([session.executionHostId, session.structuredSession.workspaceId])
        )
      : undefined
    const folderMatch = !session.structuredSession ? matchFolder(session) : null
    const matchingFolders = folderMatch
      ? foldersByPath.get(
          JSON.stringify([session.executionHostId, folderGroupKey(folderMatch.path)])
        )
      : undefined
    const folderGroup = owned ?? (matchingFolders?.length === 1 ? matchingFolders[0] : undefined)
    if (folderGroup) {
      folderGroup.sessions.push(session)
      continue
    }
    const key = JSON.stringify([session.executionHostId, project?.key ?? 'unknown'])
    const group = orphans.get(key) ?? {
      key,
      label: project?.label || session.cwd || 'Other conversations',
      sessions: [],
      repoIds: new Set<string>(),
      executionHostId: session.executionHostId
    }
    group.sessions.push(session)
    orphans.set(key, group)
  }
  const result = [...groups, ...folderGroups.values(), ...orphans.values()]
  const hostsByLabel = new Map<string, Set<ExecutionHostId>>()
  for (const group of result) {
    const hosts = hostsByLabel.get(group.label) ?? new Set<ExecutionHostId>()
    hosts.add(group.executionHostId)
    hostsByLabel.set(group.label, hosts)
  }
  return result.map((group) =>
    (hostsByLabel.get(group.label)?.size ?? 0) > 1
      ? { ...group, label: `${group.label} · ${getExecutionHostLabel(group.executionHostId)}` }
      : group
  )
}
