import { useCallback, useMemo } from 'react'
import { useAppStore } from '@/store'
import { findIndexedWorktreeOwner } from '@/lib/worktree-runtime-owner-index'
import { translate } from '@/i18n/i18n'
import { buildTaskSourceContextFromRepo } from '../../../../shared/task-source-context'
import { parseIssueLinkInput, type IssueLinkProvider } from '../../../../shared/issue-link-input'
import type { Worktree, WorktreeMeta } from '../../../../shared/types'
import {
  buildResolvedJiraIssueLinkUpdates,
  type WorktreeMetaLiveLinks
} from './worktree-meta-updates'
import { resolveJiraIssueLink, type JiraIssueLinkErrorKind } from './worktree-jira-issue-link'

/** Maps a Jira link resolution failure to a message that tells the user what to
 *  fix — a bare API toast would only echo a status code. */
function jiraLinkErrorMessage(kind: JiraIssueLinkErrorKind): string {
  switch (kind) {
    case 'not-connected':
      return translate(
        'auto.components.sidebar.WorktreeMetaDialog.136795efad',
        'Connect Jira in Settings before linking an issue.'
      )
    case 'site-not-connected':
      return translate(
        'auto.components.sidebar.WorktreeMetaDialog.9c3e2078a4',
        "That Jira site isn't connected. Connect it, or enter a bare issue key to use the active site."
      )
    case 'ambiguous-site':
      return translate(
        'auto.components.sidebar.WorktreeMetaDialog.764b478e40',
        'Several Jira sites are connected. Paste a full Jira issue URL so the site is unambiguous.'
      )
    case 'not-found':
      return translate(
        'auto.components.sidebar.WorktreeMetaDialog.9560604f22',
        'That Jira issue was not found. Check the key and your access.'
      )
  }
}

export type JiraIssueLinkSaveOutcome =
  | { kind: 'not-jira' }
  | { kind: 'updates'; updates: Partial<WorktreeMeta> }
  | { kind: 'error'; error: string }

/** Owns the async half of the meta dialog's issue field: a Jira link needs its
 *  title and URL resolved from the connected site before it can be persisted, so
 *  the synchronous update builder defers to this. Returns the updates to merge, a
 *  user-facing error, or `not-jira` when the field is not a Jira write. */
export function useWorktreeMetaJiraLink(args: {
  worktreeId: string
  ownerRepoId: string | null
  worktree: Worktree | undefined
}): {
  resolveJiraIssueLinkUpdates: (input: {
    issueProvider: IssueLinkProvider
    issueInput: string
    isDirty: boolean
    live: WorktreeMetaLiveLinks
  }) => Promise<JiraIssueLinkSaveOutcome>
} {
  const { worktreeId, ownerRepoId, worktree } = args
  const repos = useAppStore((s) => s.repos)
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const readJiraStatus = useAppStore((s) => s.readJiraStatus)
  const lookupJiraIssueSummary = useAppStore((s) => s.lookupJiraIssueSummary)

  const issueRepo = useMemo(() => {
    const repoId = ownerRepoId ?? findIndexedWorktreeOwner(worktreesByRepo, worktreeId)?.repoId
    return repoId ? repos.find((repo) => repo.id === repoId) : undefined
  }, [ownerRepoId, repos, worktreesByRepo, worktreeId])

  // Why: the lookup runs against the worktree's repo runtime. Prefer a stored
  // Jira source context (a workspace opened from a Jira task carries the right
  // project scope); otherwise derive one from the repo like the composer fallback.
  const jiraSourceContext = useMemo(() => {
    const stored = worktree?.linkedTaskSourceContext
    if (stored?.provider === 'jira') {
      return stored
    }
    return issueRepo
      ? buildTaskSourceContextFromRepo({
          provider: 'jira',
          projectId: issueRepo.id,
          repo: issueRepo
        })
      : null
  }, [issueRepo, worktree?.linkedTaskSourceContext])

  const resolveJiraIssueLinkUpdates = useCallback(
    async (input: {
      issueProvider: IssueLinkProvider
      issueInput: string
      isDirty: boolean
      live: WorktreeMetaLiveLinks
    }): Promise<JiraIssueLinkSaveOutcome> => {
      if (input.issueProvider !== 'jira' || input.issueInput.trim() === '' || !input.isDirty) {
        return { kind: 'not-jira' }
      }
      const parsed = parseIssueLinkInput(input.issueInput.trim(), 'jira')
      if (parsed?.provider !== 'jira' || !jiraSourceContext) {
        return { kind: 'error', error: jiraLinkErrorMessage('not-connected') }
      }
      try {
        const resolved = await resolveJiraIssueLink({
          parsed,
          sourceContext: jiraSourceContext,
          readStatus: readJiraStatus,
          lookupSummary: lookupJiraIssueSummary
        })
        if (!resolved.ok) {
          return { kind: 'error', error: jiraLinkErrorMessage(resolved.errorKind) }
        }
        return { kind: 'updates', updates: buildResolvedJiraIssueLinkUpdates(resolved, input.live) }
      } catch {
        // Why: the Jira reads can reject on a dead runtime or transport fault.
        // Without this the rejection escapes handleSave's finally as an unhandled
        // rejection and the user is left without an error.
        return {
          kind: 'error',
          error: translate(
            'auto.components.sidebar.WorktreeMetaDialog.a3d824d1b8',
            'Could not link the Jira issue. Check your Jira connection and try again.'
          )
        }
      }
    },
    [jiraSourceContext, readJiraStatus, lookupJiraIssueSummary]
  )

  return { resolveJiraIssueLinkUpdates }
}
