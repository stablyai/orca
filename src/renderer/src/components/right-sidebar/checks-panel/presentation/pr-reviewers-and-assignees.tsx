import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { PRAssigneesPanel } from '@/components/github/PRAssigneesPanel'
import { PRReviewersPanel } from '@/components/pull-request-page/reviewers/panel'
import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/work-items/github/github-work-item-source-lookup'
import { getTaskPageRepoSourceContext } from '@/lib/work-items/task-repo-source-context'
import type { Repo } from '../../../../../../shared/repo-types'
import type {
  GitHubAssignableUser,
  PRInfo
} from '../../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../../shared/github/work-item-types'

type LoadedPRWorkItem = { key: string; item: GitHubWorkItem | null }

export function ChecksPanelPRReviewersAndAssignees({
  repo,
  pr
}: {
  repo: Repo
  pr: PRInfo
}): React.JSX.Element | null {
  const [loaded, setLoaded] = useState<LoadedPRWorkItem | null>(null)
  const [mutationCount, setMutationCount] = useState(0)
  const sourceContext = useMemo(() => getTaskPageRepoSourceContext(repo, 'github'), [repo])
  const owner = pr.prRepo?.owner
  const ownerRepo = pr.prRepo?.repo
  const host = pr.prRepo?.host
  // Why: updatedAt moves when reviewers or assignees change, so the pane's existing PR refresh drives this fetch.
  const requestKey =
    owner && ownerRepo ? [repo.id, owner, ownerRepo, host, pr.number].join('\0') : null

  useEffect(() => {
    if (!requestKey || !owner || !ownerRepo) {
      return
    }
    let cancelled = false
    void lookupGitHubWorkItemByOwnerRepoForSource({
      repoPath: repo.path,
      repoId: repo.id,
      sourceContext,
      owner,
      repo: ownerRepo,
      ...(host ? { host } : {}),
      number: pr.number,
      type: 'pr',
      accepts: () => !cancelled
    }).then(
      (item) => {
        if (!cancelled) {
          setLoaded({ key: requestKey, item })
        }
      },
      () => {
        if (!cancelled) {
          setLoaded((current) => (current?.key === requestKey ? current : null))
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [
    requestKey,
    owner,
    ownerRepo,
    host,
    pr.number,
    pr.updatedAt,
    repo.id,
    repo.path,
    sourceContext,
    mutationCount
  ])

  const handleMutated = useCallback(() => setMutationCount((count) => count + 1), [])
  const handleReviewersRequested = useCallback(
    (reviewRequests: GitHubAssignableUser[]) =>
      setLoaded((current) =>
        current?.item ? { ...current, item: { ...current.item, reviewRequests } } : current
      ),
    []
  )

  const item = loaded?.key === requestKey ? loaded.item : null
  if (!item) {
    return null
  }
  return (
    <div className="flex flex-col gap-4 border-b border-border px-3 py-3">
      <PRReviewersPanel
        item={item}
        loading={false}
        repoPath={repo.path}
        sourceContext={sourceContext}
        onReviewersRequested={handleReviewersRequested}
        onMutated={handleMutated}
      />
      <PRAssigneesPanel
        item={item}
        repoPath={repo.path}
        projectOrigin={undefined}
        sourceContext={sourceContext}
        onMutated={handleMutated}
      />
    </div>
  )
}
