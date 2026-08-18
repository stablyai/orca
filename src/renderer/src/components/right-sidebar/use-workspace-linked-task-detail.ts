import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import { useRepoById } from '@/store/selectors'
import { issueCacheKey as getIssueCacheKey } from '@/store/slices/github'
import type { WorkspaceLinkedTask } from './workspace-linked-task'

export type WorkspaceLinkedTaskDetail = {
  /** Best known title: the provider's own, falling back to the stored one. */
  title: string
  /** Best known URL: the provider's own, falling back to the stored one. */
  url: string
  /** Provider-native state label, when the provider cache holds one. */
  state: string | null
  /** Markdown body, when the provider cache holds one. */
  description: string | null
  /** True while the first read for a rich provider has not answered yet. */
  loading: boolean
}

/** Reads the linked item's detail out of the caches the app already fills.
 *
 *  Why cache-only: the panel adds no provider transport of its own. GitHub
 *  issues and Linear issues are already cached per workspace for the sidebar
 *  card, so their body renders for free; the other providers show the stored
 *  reference and title, which is enough to identify the item and open it. */
export function useWorkspaceLinkedTaskDetail(
  task: WorkspaceLinkedTask | null
): WorkspaceLinkedTaskDetail {
  const repoId = task?.repoId ?? null
  const repo = useRepoById(repoId)
  const settings = useAppStore((s) => s.settings)
  const fetchIssue = useAppStore((s) => s.fetchIssue)
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)

  const wantsGitHubIssue = task?.provider === 'github' && task.type === 'issue'
  const issueKey =
    wantsGitHubIssue && repo
      ? getIssueCacheKey(
          repo.path,
          repo.id,
          task.number,
          settings,
          repo.connectionId,
          repo.executionHostId,
          true
        )
      : ''
  const issueEntry = useAppStore((s) => (issueKey ? s.issueCache[issueKey] : undefined))

  const linearIdentifier = task?.provider === 'linear' ? (task.linearIdentifier ?? null) : null
  // Why: the 'all::' scope is what the sidebar card reads, because the issue may
  // belong to a different Linear workspace than the selected one.
  const linearEntry = useAppStore((s) =>
    linearIdentifier ? s.linearIssueCache[`all::${linearIdentifier}`] : undefined
  )
  const linearFallbackEntry = useAppStore((s) =>
    linearIdentifier ? s.linearIssueCache[linearIdentifier] : undefined
  )

  // Why: one read per item when the panel opens on an empty cache. The card's
  // own refresh path only runs while issue decorations are enabled, so without
  // this the panel would sit on a stored title for users who turned them off.
  const requestedRef = useRef<string | null>(null)
  const repoPath = repo?.path ?? null
  const taskNumber = task?.number ?? null
  const hasIssueEntry = issueEntry !== undefined
  const hasLinearEntry = linearEntry !== undefined || linearFallbackEntry !== undefined
  useEffect(() => {
    if (wantsGitHubIssue && repoPath && repoId && taskNumber !== null && !hasIssueEntry) {
      const requestKey = `github ${repoId} ${taskNumber}`
      if (requestedRef.current !== requestKey) {
        requestedRef.current = requestKey
        void fetchIssue(repoPath, taskNumber, { repoId })
      }
      return
    }
    if (linearIdentifier && !hasLinearEntry) {
      const requestKey = `linear ${linearIdentifier}`
      if (requestedRef.current !== requestKey) {
        requestedRef.current = requestKey
        void fetchLinearIssue(linearIdentifier)
      }
    }
  }, [
    fetchIssue,
    fetchLinearIssue,
    hasIssueEntry,
    hasLinearEntry,
    linearIdentifier,
    repoId,
    repoPath,
    taskNumber,
    wantsGitHubIssue
  ])

  const issue = issueEntry?.data ?? null
  const linearIssue = (linearEntry ?? linearFallbackEntry)?.data ?? null
  const storedTitle = task?.title ?? ''
  const storedUrl = task?.url ?? ''

  if (issue) {
    return {
      title: issue.title || storedTitle,
      url: issue.url || storedUrl,
      state: issue.state,
      description: issue.description ?? null,
      loading: false
    }
  }
  if (linearIssue) {
    return {
      title: linearIssue.title || storedTitle,
      url: linearIssue.url || storedUrl,
      state: linearIssue.state.name,
      description: linearIssue.description ?? null,
      loading: false
    }
  }
  return {
    title: storedTitle,
    url: storedUrl,
    state: null,
    description: null,
    loading: Boolean(
      wantsGitHubIssue ? !hasIssueEntry : linearIdentifier !== null && !hasLinearEntry
    )
  }
}
