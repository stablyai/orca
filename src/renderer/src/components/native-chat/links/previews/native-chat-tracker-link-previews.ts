import { useAppStore } from '@/store'
import { lookupGitLabWorkItemByPathForSource } from '@/lib/work-items/gitlab/gitlab-work-item-source-lookup'
import type { JiraIssue } from '../../../../../../shared/jira/jira-types'
import type { GitLabWorkItem } from '../../../../../../shared/gitlab-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { buildTaskSourceContextFromRepo } from '../../../../../../shared/work-items/task-source-context'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'

export type GitLabChatLink = {
  slug: { host: string; path: string }
  number: number
  type: 'issue' | 'mr'
}

const jiraPreviews = createHoverPreviewCache<JiraIssue>({ freshMs: 60_000, maxEntries: 200 })
const gitLabPreviews = createHoverPreviewCache<GitLabWorkItem>({ freshMs: 60_000, maxEntries: 200 })

export function jiraLinkPreviewKey(siteId: string, key: string): string {
  return `jira:${siteId}:${key}`
}

export function readCachedJiraLinkPreview(siteId: string, key: string): JiraIssue | null {
  return jiraPreviews.read(jiraLinkPreviewKey(siteId, key))
}

/** Reads through the store, which routes Jira to its connected host and shares the Tasks cache. */
export function loadJiraLinkPreview(siteId: string, key: string): Promise<JiraIssue | null> {
  return jiraPreviews.load(jiraLinkPreviewKey(siteId, key), () =>
    useAppStore.getState().fetchJiraIssue(key, siteId)
  )
}

/** Repo ids repeat across hosts, and each host answers with its own GitLab sign-in. */
export function gitLabLinkPreviewKey(repo: Repo, link: GitLabChatLink): string {
  return `${getRepoExecutionHostId(repo)}:${repo.id}:${link.slug.host}/${link.slug.path}#${link.type}${link.number}`
}

export function readCachedGitLabLinkPreview(
  repo: Repo,
  link: GitLabChatLink
): GitLabWorkItem | null {
  return gitLabPreviews.read(gitLabLinkPreviewKey(repo, link))
}

/** `repo` only picks the host and GitLab sign-in that send the request; the link's own host and path name the project. */
export function loadGitLabLinkPreview(
  repo: Repo,
  link: GitLabChatLink
): Promise<GitLabWorkItem | null> {
  return gitLabPreviews.load(gitLabLinkPreviewKey(repo, link), () =>
    lookupGitLabWorkItemByPathForSource({
      repoPath: repo.path,
      repoId: repo.id,
      sourceContext: buildTaskSourceContextFromRepo({
        provider: 'gitlab',
        projectId: repo.id,
        repo
      }),
      host: link.slug.host,
      path: link.slug.path,
      iid: link.number,
      type: link.type
    })
  )
}
