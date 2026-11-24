import { useCallback, useEffect, useState } from 'react'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
import type { IssueInfo } from '../../../../shared/github/pull-requests/pull-request-types'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { useActiveRepo } from '@/store/repos/use-repository-catalog'
import { runWithBusyFlag } from '@/lib/run-with-busy-flag'

const KANBAN_ISSUE_LIMIT = 50

export function useWorkbenchKanbanIssues() {
  const repo = useActiveRepo()
  const [issues, setIssues] = useState<readonly IssueInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!repo) {
      return
    }
    const target = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo))
    if (!target) {
      setError('No routable host for the active repository.')
      return
    }
    setError(null)
    try {
      await runWithBusyFlag(setLoading, async () => {
        const items =
          target.kind === 'environment'
            ? await callRuntimeRpc<IssueInfo[]>(
                target,
                'github.listIssues',
                { repo: repo.id, limit: KANBAN_ISSUE_LIMIT },
                { timeoutMs: 30_000 }
              )
            : await window.api.gh.listIssues({
                repoPath: repo.path,
                repoId: repo.id,
                limit: KANBAN_ISSUE_LIMIT
              })
        setIssues(items)
      })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }, [repo])

  useEffect(() => {
    void reload()
  }, [reload])

  return { issues, loading, error, reload, hasRepo: repo !== null && repo !== undefined }
}
