import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  CircleDashed,
  CircleMinus,
  GitPullRequest,
  Files
} from 'lucide-react'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PRInfo, PRCheckDetail } from '../../../../shared/types'

export const PullRequestIcon = GitPullRequest

export const CHECK_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  success: CircleCheck,
  failure: CircleX,
  pending: LoaderCircle,
  neutral: CircleDashed,
  skipped: CircleMinus,
  cancelled: CircleX,
  timed_out: CircleX
}

export const CHECK_COLOR: Record<string, string> = {
  success: 'text-emerald-500',
  failure: 'text-rose-500',
  pending: 'text-amber-500',
  neutral: 'text-muted-foreground',
  skipped: 'text-muted-foreground/60',
  cancelled: 'text-muted-foreground/60',
  timed_out: 'text-rose-500'
}

export function ConflictingFilesSection({ pr }: { pr: PRInfo }): React.JSX.Element | null {
  const files = pr.conflictSummary?.files ?? []
  if (pr.mergeable !== 'CONFLICTING' || files.length === 0) {
    return null
  }

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="text-[11px] font-medium text-foreground">
        This branch has conflicts that must be resolved
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">
        It&apos;s {pr.conflictSummary!.commitsBehind} commit
        {pr.conflictSummary!.commitsBehind === 1 ? '' : 's'} behind (base commit:{' '}
        <span className="font-mono text-[10px]">{pr.conflictSummary!.baseCommit}</span>)
      </div>
      <div className="mt-2 flex items-center gap-2">
        <Files className="size-3.5 shrink-0 text-muted-foreground" />
        <div className="text-[11px] text-muted-foreground">Conflicting files</div>
      </div>
      <div className="mt-2 space-y-2">
        {files.map((filePath) => (
          <div key={filePath} className="rounded-md border border-border bg-accent/20 px-2.5 py-2">
            <div className="break-all font-mono text-[11px] leading-4 text-foreground">
              {filePath}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

/** Fallback shown when GitHub reports merge conflicts but no file list is available yet. */
export function MergeConflictNotice({ pr }: { pr: PRInfo }): React.JSX.Element | null {
  if (pr.mergeable !== 'CONFLICTING' || (pr.conflictSummary?.files.length ?? 0) > 0) {
    return null
  }

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="text-[11px] font-medium text-foreground">
        This branch has conflicts that must be resolved
      </div>
      <div className="mt-1 text-[11px] text-muted-foreground">Refreshing conflict details…</div>
    </div>
  )
}

const CHECK_SORT_ORDER: Record<string, number> = {
  failure: 0,
  timed_out: 0,
  cancelled: 1,
  pending: 2,
  neutral: 3,
  skipped: 4,
  success: 5
}

/** Renders the checks summary bar + scrollable check list. */
export function ChecksList({
  checks,
  checksLoading
}: {
  checks: PRCheckDetail[]
  checksLoading: boolean
}): React.JSX.Element {
  const sorted = [...checks].sort(
    (a, b) =>
      (CHECK_SORT_ORDER[a.conclusion ?? 'pending'] ?? 3) -
      (CHECK_SORT_ORDER[b.conclusion ?? 'pending'] ?? 3)
  )
  const passingCount = checks.filter((c) => c.conclusion === 'success').length
  const failingCount = checks.filter(
    (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out'
  ).length
  const pendingCount = checks.filter(
    (c) => c.conclusion === 'pending' || c.conclusion === null
  ).length

  return (
    <>
      {/* Checks Summary */}
      {checks.length > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 border-b border-border text-[10px] text-muted-foreground">
          {passingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleCheck className="size-3 text-emerald-500" />
              {passingCount} passing
            </span>
          )}
          {failingCount > 0 && (
            <span className="flex items-center gap-1">
              <CircleX className="size-3 text-rose-500" />
              {failingCount} failing
            </span>
          )}
          {pendingCount > 0 && (
            <span className="flex items-center gap-1">
              <LoaderCircle className="size-3 text-amber-500" />
              {pendingCount} pending
            </span>
          )}
        </div>
      )}

      {/* Checks List */}
      {checksLoading && checks.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : checks.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-[11px] text-muted-foreground">
          No checks configured
        </div>
      ) : (
        <div className="py-1">
          {sorted.map((check) => {
            const conclusion = check.conclusion ?? 'pending'
            const Icon = CHECK_ICON[conclusion] ?? CircleDashed
            const color = CHECK_COLOR[conclusion] ?? 'text-muted-foreground'
            return (
              <div
                key={check.name}
                className={cn(
                  'flex items-center gap-2 px-3 py-1.5 hover:bg-accent/40 transition-colors',
                  check.url && 'cursor-pointer'
                )}
                onClick={() => {
                  if (check.url) {
                    window.api.shell.openUrl(check.url)
                  }
                }}
              >
                <Icon
                  className={cn(
                    'size-3.5 shrink-0',
                    color,
                    conclusion === 'pending' && 'animate-spin'
                  )}
                />
                <span className="flex-1 truncate text-[12px] text-foreground">{check.name}</span>
                {check.url && <ExternalLink className="size-3 text-muted-foreground/40 shrink-0" />}
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

export function prStateColor(state: PRInfo['state']): string {
  switch (state) {
    case 'merged':
      return 'bg-purple-500/15 text-purple-500 border-purple-500/20'
    case 'open':
      return 'bg-emerald-500/15 text-emerald-500 border-emerald-500/20'
    case 'closed':
      return 'bg-muted text-muted-foreground border-border'
    case 'draft':
      return 'bg-muted text-muted-foreground/70 border-border'
  }
}
