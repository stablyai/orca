import React from 'react'
import { AlertTriangle, CircleDashed, LoaderCircle, RotateCw } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { resolveMultiRepoExecutionHostId } from '@/lib/multi-repo-execution-host'
import { translate } from '@/i18n/i18n'
import { selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { buildRootPanelModel, type RootPanelRow } from './root-panel-model'
import { getRootPanelStatusDetail, getRootPanelStatusText } from './root-panel-copy'

const ATTENTION_KINDS = new Set(['queued', 'creating', 'failed', 'interrupted'])

function AttentionIcon({ row }: { row: RootPanelRow }): React.JSX.Element {
  // Decorative: the status text beside it names the state.
  if (row.status.kind === 'creating') {
    return (
      <LoaderCircle
        aria-hidden="true"
        className="size-3 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
      />
    )
  }
  if (row.status.kind === 'queued') {
    return <CircleDashed aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />
  }
  return <AlertTriangle aria-hidden="true" className="size-3 shrink-0 text-destructive" />
}

/**
 * The members of a multi-repo workspace that have no worktree yet (queued, creating, failed,
 * interrupted). They have no sidebar row of their own, so they are listed under the parent with
 * their state in words and a Retry for the ones that stopped.
 */
export default function MultiRepoAttentionRows({
  folderWorkspace
}: {
  folderWorkspace: FolderWorkspace
}): React.JSX.Element | null {
  const repos = useAppStore((state) => state.repos)
  const worktreesByRepo = useAppStore((state) => selectWorktreesByRepo(state))
  const runMemberAction = useAppStore((state) => state.runMultiRepoMemberAction)
  const [pending, setPending] = React.useState<ReadonlySet<string>>(new Set())
  const model = React.useMemo(
    () => buildRootPanelModel({ folderWorkspace, repos, worktreesByRepo, gitStatusByWorktree: {} }),
    [folderWorkspace, repos, worktreesByRepo]
  )
  const rows = model?.rows.filter((row) => ATTENTION_KINDS.has(row.status.kind)) ?? []
  if (rows.length === 0) {
    return null
  }
  const executionHostId = resolveMultiRepoExecutionHostId(folderWorkspace)
  const retry = async (memberId: string): Promise<void> => {
    setPending((current) => new Set(current).add(memberId))
    try {
      await runMemberAction('retryMember', {
        folderWorkspaceId: folderWorkspace.id,
        memberId,
        ...(executionHostId ? { executionHostId } : {})
      })
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      setPending((current) => {
        const next = new Set(current)
        next.delete(memberId)
        return next
      })
    }
  }
  return (
    <ul className="space-y-0.5 pb-1 pl-9 pr-3" data-multi-repo-attention="">
      {rows.map((row) => (
        <li key={row.memberId} className="flex min-w-0 items-center gap-1.5 text-xs">
          <AttentionIcon row={row} />
          <span className="min-w-0 truncate text-foreground">{row.label}</span>
          <span
            className="min-w-0 truncate text-muted-foreground"
            title={getRootPanelStatusDetail(row.status)}
          >
            {getRootPanelStatusText(row.status)}
          </span>
          {row.canRetry ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto"
              disabled={pending.has(row.memberId)}
              aria-label={translate('auto.components.multiRepo.root.retryRepo', 'Retry {{repo}}', {
                repo: row.label
              })}
              onClick={(event) => {
                // The row behind this button activates the workspace; a retry must not.
                event.stopPropagation()
                void retry(row.memberId)
              }}
              onPointerDown={(event) => event.stopPropagation()}
            >
              <RotateCw />
              {translate('auto.components.multiRepo.root.retry', 'Retry')}
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
