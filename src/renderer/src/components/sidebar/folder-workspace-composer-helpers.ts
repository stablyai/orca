import { buildLinearIssueLinkedWorkItem } from '@/lib/linear-linked-work-item'
import {
  getLinkedWorkItemProvider,
  getLinkedWorkItemWorkspaceName,
  type LinkedWorkItemSummary
} from '@/lib/new-workspace'
import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import { getProjectGroupSubtreeIds } from '../../../../shared/project-groups'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type {
  FolderWorkspace,
  GitHubWorkItem,
  GitLabWorkItem,
  LinearIssue,
  ProjectGroup,
  Repo,
  TuiAgent
} from '../../../../shared/types'
import type { SmartWorkspaceNameSelection } from '@/components/new-workspace/SmartWorkspaceNameField'
import { translate } from '@/i18n/i18n'

const EMPTY_REPOS: Repo[] = []

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
  return repos.filter(
    (repo) =>
      isGitRepoKind(repo) &&
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
  const provider = getLinkedWorkItemProvider(item)
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
  if (!linkedWorkItem) {
    return null
  }
  const provider = getLinkedWorkItemProvider(linkedWorkItem)
  const kind: SmartWorkspaceNameSelection['kind'] =
    provider === 'linear'
      ? 'linear'
      : provider === 'jira'
        ? 'jira'
        : provider === 'gitlab'
          ? linkedWorkItem.type === 'mr'
            ? 'gitlab-mr'
            : 'gitlab-issue'
          : linkedWorkItem.type === 'pr'
            ? 'github-pr'
            : 'github-issue'
  return {
    kind,
    label:
      provider === 'linear' || provider === 'jira' || linkedWorkItem.number === 0
        ? linkedWorkItem.title
        : `#${linkedWorkItem.number} ${linkedWorkItem.title}`,
    url: linkedWorkItem.url
  }
}

export function getLinkedItemDisplayName(item: LinkedWorkItemSummary): string | null {
  return getLinkedWorkItemWorkspaceName(item)?.displayName ?? (item.title.trim() || null)
}

export function toGitHubLinkedWorkItem(item: GitHubWorkItem): LinkedWorkItemSummary {
  return {
    type: item.type,
    provider: 'github',
    number: item.number,
    title: item.title,
    url: item.url,
    repoId: item.repoId
  }
}

export function toGitLabLinkedWorkItem(item: GitLabWorkItem): LinkedWorkItemSummary {
  return {
    type: item.type,
    provider: 'gitlab',
    number: item.number,
    title: item.title,
    url: item.url,
    repoId: item.repoId
  }
}

export function toLinearLinkedWorkItem(issue: LinearIssue): LinkedWorkItemSummary {
  return buildLinearIssueLinkedWorkItem(issue)
}

export function getFolderWorkspacePrimaryActionLabel(quickAgent: TuiAgent | null): string {
  return quickAgent
    ? translate(
        'auto.components.sidebar.FolderWorkspaceComposerDialog.createStart',
        'Create & Start Agent'
      )
    : translate('auto.components.sidebar.FolderWorkspaceComposerDialog.create', 'Create Workspace')
}
