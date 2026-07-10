import React, { useCallback, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, GitBranch, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { useActiveWorktree, useActiveWorktreeId, useRepoById } from '../../store/selectors'
import { getConnectionId } from '../../lib/connection-context'
import { getWorktreeGitIdentityDisplay } from '../../lib/worktree-git-identity-display'
import {
  fetchRuntimeGit,
  getRuntimeGitUpstreamStatus,
  pullRuntimeGit,
  pushRuntimeGit,
  type RuntimeGitContext
} from '../../runtime/runtime-git-client'
import type { GitPushTarget } from '../../../../shared/types'
import type { GitUpstreamStatus } from '../../../../shared/git-status-types'

type GitAction = 'fetch' | 'pull' | 'push' | 'sync'

// Why: amber signals "needs attention" per Orca's status convention; emerald means
// in-sync, and muted means there is no upstream to compare against.
export function syncDotColor(upstream: GitUpstreamStatus | undefined): string {
  if (!upstream?.hasUpstream) {
    return 'bg-muted-foreground/40'
  }
  if (upstream.ahead > 0 || upstream.behind > 0) {
    return 'bg-amber-500'
  }
  return 'bg-emerald-500'
}

// Why: fetch/pull/push all need a resolved upstream; without one there is no
// remote ref to reconcile against, so the actions must stay disabled.
export function isRemoteActionEnabled(upstream: GitUpstreamStatus | undefined): boolean {
  return upstream?.hasUpstream ?? false
}

export function GitBranchStatusSegment({
  compact,
  iconOnly
}: {
  compact: boolean
  iconOnly: boolean
}): React.JSX.Element | null {
  const activeWorktreeId = useActiveWorktreeId()
  const activeWorktree = useActiveWorktree()
  const activeRepo = useRepoById(activeWorktree?.repoId ?? null)
  const settings = useAppStore((s) => s.settings)
  const upstream = useAppStore((s) =>
    activeWorktreeId ? s.remoteStatusesByWorktree[activeWorktreeId] : undefined
  )
  const setUpstreamStatus = useAppStore((s) => s.setUpstreamStatus)
  const setRightSidebarOpen = useAppStore((s) => s.setRightSidebarOpen)
  const setRightSidebarTab = useAppStore((s) => s.setRightSidebarTab)

  const [busyAction, setBusyAction] = useState<GitAction | null>(null)

  const identity = useMemo(
    () =>
      activeWorktree
        ? getWorktreeGitIdentityDisplay({
            branch: activeWorktree.branch,
            head: activeWorktree.head
          })
        : null,
    [activeWorktree]
  )

  const pushTarget: GitPushTarget | undefined = activeWorktree?.pushTarget

  const buildContext = useCallback((): RuntimeGitContext | null => {
    if (!activeWorktree?.path) {
      return null
    }
    const connectionId = getConnectionId(activeWorktreeId) ?? activeRepo?.connectionId ?? undefined
    return {
      settings,
      worktreeId: activeWorktreeId,
      worktreePath: activeWorktree.path,
      connectionId: connectionId ?? undefined
    }
  }, [activeRepo?.connectionId, activeWorktree?.path, activeWorktreeId, settings])

  const refreshUpstream = useCallback(
    async (context: RuntimeGitContext): Promise<void> => {
      if (!activeWorktreeId) {
        return
      }
      try {
        const next = await getRuntimeGitUpstreamStatus(context, pushTarget)
        setUpstreamStatus(activeWorktreeId, next)
      } catch {
        // Why: the indicator refresh is best-effort; the periodic poll will
        // reconcile it, so a transient failure here must not surface an error.
      }
    },
    [activeWorktreeId, pushTarget, setUpstreamStatus]
  )

  const runAction = useCallback(
    async (action: GitAction): Promise<void> => {
      const context = buildContext()
      if (!context || busyAction) {
        return
      }
      setBusyAction(action)
      try {
        if (action === 'fetch') {
          await fetchRuntimeGit(context, pushTarget)
        } else if (action === 'pull') {
          await pullRuntimeGit(context, pushTarget)
        } else if (action === 'push') {
          await pushRuntimeGit(context, pushTarget ? { pushTarget } : {})
        } else {
          // Sync: reconcile remote first, then publish local commits.
          await pullRuntimeGit(context, pushTarget)
          await pushRuntimeGit(context, pushTarget ? { pushTarget } : {})
        }
        await refreshUpstream(context)
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate(
                'auto.components.status.bar.GitBranchStatusSegment.action_failed',
                'Git action failed'
              )
        )
      } finally {
        setBusyAction(null)
      }
    },
    [buildContext, busyAction, pushTarget, refreshUpstream]
  )

  if (!activeWorktree || !identity) {
    return null
  }

  const branchLabel = identity.kind === 'branch' ? identity.branchName : identity.shortHead
  const hasUpstream = isRemoteActionEnabled(upstream)
  const ahead = upstream?.ahead ?? 0
  const behind = upstream?.behind ?? 0
  const busy = busyAction !== null
  const isDetached = identity.kind === 'detached'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 cursor-pointer rounded px-1 py-0.5 hover:bg-accent/70"
          aria-label={translate(
            'auto.components.status.bar.GitBranchStatusSegment.aria_label',
            'Current branch and remote sync status'
          )}
        >
          {busy ? (
            <Loader2 className="size-3 animate-spin text-muted-foreground" />
          ) : (
            <GitBranch className="size-3 text-muted-foreground" />
          )}
          {!iconOnly && (
            <span className="max-w-[12rem] truncate text-[11px] text-muted-foreground">
              {branchLabel}
            </span>
          )}
          {hasUpstream && !compact && (ahead > 0 || behind > 0) && (
            <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-foreground">
              {ahead > 0 && (
                <span className="inline-flex items-center">
                  <ArrowUp className="size-3" />
                  {ahead}
                </span>
              )}
              {behind > 0 && (
                <span className="inline-flex items-center">
                  <ArrowDown className="size-3" />
                  {behind}
                </span>
              )}
            </span>
          )}
          <span className={`inline-block size-1.5 rounded-full ${syncDotColor(upstream)}`} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[min(18rem,calc(100vw-1rem))]"
      >
        <DropdownMenuLabel className="flex items-center gap-1.5 truncate">
          <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{branchLabel}</span>
        </DropdownMenuLabel>
        <div className="px-2 pb-1 text-[11px] text-muted-foreground">
          {isDetached
            ? translate(
                'auto.components.status.bar.GitBranchStatusSegment.detached_head',
                'Detached HEAD — no branch to sync'
              )
            : !hasUpstream
              ? translate(
                  'auto.components.status.bar.GitBranchStatusSegment.no_upstream',
                  'No upstream branch set'
                )
              : ahead === 0 && behind === 0
                ? translate(
                    'auto.components.status.bar.GitBranchStatusSegment.in_sync',
                    'Up to date with remote'
                  )
                : translate(
                    'auto.components.status.bar.GitBranchStatusSegment.ahead_behind',
                    '{{value0}} ahead, {{value1}} behind',
                    { value0: String(ahead), value1: String(behind) }
                  )}
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          disabled={busy || !hasUpstream}
          onSelect={(event) => {
            event.preventDefault()
            void runAction('sync')
          }}
        >
          {busyAction === 'sync' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          {translate(
            'auto.components.status.bar.GitBranchStatusSegment.sync',
            'Sync (Pull then Push)'
          )}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy || !hasUpstream}
          onSelect={(event) => {
            event.preventDefault()
            void runAction('fetch')
          }}
        >
          {busyAction === 'fetch' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ArrowDown className="size-3.5" />
          )}
          {translate('auto.components.status.bar.GitBranchStatusSegment.fetch', 'Fetch')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy || !hasUpstream}
          onSelect={(event) => {
            event.preventDefault()
            void runAction('pull')
          }}
        >
          {busyAction === 'pull' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ArrowDown className="size-3.5" />
          )}
          {translate('auto.components.status.bar.GitBranchStatusSegment.pull', 'Pull')}
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={busy || !hasUpstream}
          onSelect={(event) => {
            event.preventDefault()
            void runAction('push')
          }}
        >
          {busyAction === 'push' ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <ArrowUp className="size-3.5" />
          )}
          {translate('auto.components.status.bar.GitBranchStatusSegment.push', 'Push')}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            setRightSidebarOpen(true)
            setRightSidebarTab('source-control')
          }}
        >
          {translate(
            'auto.components.status.bar.GitBranchStatusSegment.open_source_control',
            'Open Source Control…'
          )}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
