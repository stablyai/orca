import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import {
  buildGitHubWorkspaceSource,
  buildGitLabWorkspaceSource,
  buildLinearWorkspaceSource,
  buildWorkspaceSourceSelection,
  getWorkspaceSourceName,
  getWorkspaceSourceProvider
} from '../../../../shared/new-workspace/workspace-source'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type {
  FolderWorkspace,
  GitHubWorkItem,
  GitLabWorkItem,
  LinearIssue,
  ProjectGroup,
  Repo
} from '../../../../shared/types'
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/SmartWorkspaceNameField'
import { translate } from '@/i18n/i18n'

const EMPTY_REPOS: Repo[] = []

function getProjectGroupExecutionHostId(projectGroup: ProjectGroup): ExecutionHostId {
  const executionHostId = normalizeExecutionHostId(projectGroup.executionHostId)
  if (executionHostId) {
    return executionHostId
  }
  return projectGroup.connectionId
    ? toSshExecutionHostId(projectGroup.connectionId)
    : LOCAL_EXECUTION_HOST_ID
}

export function getFolderSourceRepos(
  repos: readonly Repo[],
  projectGroups: readonly ProjectGroup[],
  projectGroup: ProjectGroup | null
): Repo[] {
  if (!projectGroup?.parentPath) {
    return EMPTY_REPOS
  }
  const folderPath = projectGroup.parentPath
  const groupIds = getProjectGroupSubtreeIds(projectGroups, projectGroup.id)
  const projectGroupHostId = getProjectGroupExecutionHostId(projectGroup)
  return repos.filter(
    (repo) =>
      isGitRepoKind(repo) &&
      getRepoExecutionHostId(repo) === projectGroupHostId &&
      ((typeof repo.projectGroupId === 'string' && groupIds.has(repo.projectGroupId)) ||
        isPathInsideOrEqual(folderPath, repo.path))
  )
}

export function toFolderWorkspaceLinkedTask(
  item: LinkedWorkItemSummary | null
): FolderWorkspace['linkedTask'] {
  if (!item) {
    return null
  }
  const provider = getWorkspaceSourceProvider(item)
  return {
    provider,
    type: item.type,
    number: item.number,
    title: item.title,
    url: item.url,
    ...(item.linearIdentifier ? { linearIdentifier: item.linearIdentifier } : {}),
    ...(item.jiraIdentifier ? { jiraIdentifier: item.jiraIdentifier } : {}),
    ...(item.repoId ? { repoId: item.repoId } : {})
  }
}

export function getSmartNameSelection(
  linkedWorkItem: LinkedWorkItemSummary | null
): SmartWorkspaceNameSelection | null {
  return buildWorkspaceSourceSelection({ linkedWorkItem }) as SmartWorkspaceNameSelection | null
}

export function getLinkedItemDisplayName(item: LinkedWorkItemSummary): string | null {
  return getWorkspaceSourceName(item).displayName || null
}

export function toGitHubLinkedWorkItem(item: GitHubWorkItem): LinkedWorkItemSummary {
  return buildGitHubWorkspaceSource(item)
}

export function toGitLabLinkedWorkItem(item: GitLabWorkItem): LinkedWorkItemSummary {
  return buildGitLabWorkspaceSource(item)
}

export function toLinearLinkedWorkItem(issue: LinearIssue): LinkedWorkItemSummary {
  return buildLinearWorkspaceSource(issue)
}

export function getFolderWorkspacePrimaryActionLabel(): string {
  return translate(
    'auto.components.sidebar.FolderWorkspaceComposerDialog.create',
    'Create workspace'
  )
}
