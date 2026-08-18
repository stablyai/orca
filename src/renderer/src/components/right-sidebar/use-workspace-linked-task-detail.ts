import { useEffect, useRef } from 'react'
import { useAppStore } from '@/store'
import type { WorkspaceLinkedTask } from './workspace-linked-task'

export type WorkspaceLinkedTaskDetail = {
  /** Best known title: the provider's own, falling back to the stored one. */
  title: string
  /** Best known URL: the provider's own, falling back to the stored one. */
  url: string
  /** Provider-native state label, when the provider answered with one. */
  state: string | null
  /** Markdown body, when the provider answered with one. */
  description: string | null
  /** True while the first read for a rich provider has not answered yet. */
  loading: boolean
  /** True once a provider answered for this item, even with an empty body.
   *  Separates "this item has no description" from "no description is readable
   *  here", which are different things to tell the user. */
  detailsLoaded: boolean
}

/** Detail for the providers the panel renders itself, i.e. everything except
 *  GitHub, which routes to its own detail view.
 *
 *  Linear answers from the cache the sidebar card already fills. Jira and GitLab
 *  fall back to what the workspace stored until their detail views are hosted in
 *  the panel too. */
export function useWorkspaceLinkedTaskDetail(
  task: WorkspaceLinkedTask | null
): WorkspaceLinkedTaskDetail {
  const fetchLinearIssue = useAppStore((s) => s.fetchLinearIssue)

  const linearIdentifier = task?.provider === 'linear' ? (task.linearIdentifier ?? null) : null
  // Why: the 'all::' scope is what the sidebar card reads, because the issue may
  // belong to a different Linear workspace than the selected one.
  const linearEntry = useAppStore((s) =>
    linearIdentifier ? s.linearIssueCache[`all::${linearIdentifier}`] : undefined
  )
  const linearFallbackEntry = useAppStore((s) =>
    linearIdentifier ? s.linearIssueCache[linearIdentifier] : undefined
  )
  const hasLinearEntry = linearEntry !== undefined || linearFallbackEntry !== undefined

  // Why: one read per identifier when the panel opens on an empty cache. The
  // card's own refresh path only runs while issue decorations are enabled, so
  // without this the panel would sit on a stored title for users who disabled them.
  const requestedLinearRef = useRef<string | null>(null)
  useEffect(() => {
    if (!linearIdentifier || hasLinearEntry || requestedLinearRef.current === linearIdentifier) {
      return
    }
    requestedLinearRef.current = linearIdentifier
    void fetchLinearIssue(linearIdentifier)
  }, [fetchLinearIssue, hasLinearEntry, linearIdentifier])

  const linearIssue = (linearEntry ?? linearFallbackEntry)?.data ?? null
  const storedTitle = task?.title ?? ''
  const storedUrl = task?.url ?? ''

  if (linearIssue) {
    const description = linearIssue.description ?? null
    return {
      title: linearIssue.title || storedTitle,
      url: linearIssue.url || storedUrl,
      state: linearIssue.state.name,
      description: description && description.trim().length > 0 ? description : null,
      loading: false,
      detailsLoaded: true
    }
  }
  return {
    title: storedTitle,
    url: storedUrl,
    state: null,
    description: null,
    loading: linearIdentifier !== null && !hasLinearEntry,
    detailsLoaded: false
  }
}
