import { useAppStore } from '@/store'
import { lookupGitLabWorkItemByPathForSource } from '@/lib/work-items/gitlab/gitlab-work-item-source-lookup'
import type { JiraIssue } from '../../../../../../shared/jira/jira-types'
import type { GitLabWorkItem } from '../../../../../../shared/gitlab-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { buildTaskSourceContextFromRepo } from '../../../../../../shared/work-items/task-source-context'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { createHoverPreviewCache } from './native-chat-hover-preview-cache'

export type GitLabChatLink = {
  slug: { host: string; path: string }
  number: number
  type: 'issue' | 'mr'
}

/** A Jira issue link, with the host whose Jira connection reads it. */
export type JiraChatLink = { hostId: ExecutionHostId; siteId: string; issueKey: string }

const jiraPreviews = createHoverPreviewCache<JiraIssue>({ freshMs: 60_000, maxEntries: 200 })
const gitLabPreviews = createHoverPreviewCache<GitLabWorkItem>({ freshMs: 60_000, maxEntries: 200 })

/** Cache key for a Jira preview; the same site can be connected on two hosts with different access. */
export function jiraLinkPreviewKey(link: JiraChatLink): string {
  return `jira:${link.hostId}:${link.siteId}:${link.issueKey}`
}

/** The last answer for this link, or null when none is fresh. */
export function readCachedJiraLinkPreview(link: JiraChatLink): JiraIssue | null {
  return jiraPreviews.read(jiraLinkPreviewKey(link))
}

/** Reads through the store on the chat's host, sharing the Tasks cache for that host. */
export function loadJiraLinkPreview(link: JiraChatLink): Promise<JiraIssue | null> {
  return jiraPreviews.load(jiraLinkPreviewKey(link), () =>
    useAppStore.getState().fetchJiraIssue(link.issueKey, link.siteId, {
      sourceContext: {
        kind: 'task-source',
        provider: 'jira',
        projectId: link.siteId,
        hostId: link.hostId
      }
    })
  )
}

/** Repo ids repeat across hosts, and each host answers with its own GitLab sign-in. */
export function gitLabLinkPreviewKey(repo: Repo, link: GitLabChatLink): string {
  return `${getRepoExecutionHostId(repo)}:${repo.id}:${link.slug.host}/${link.slug.path}#${link.type}${link.number}`
}

/** The last answer for this GitLab link, or null when none is fresh. */
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
