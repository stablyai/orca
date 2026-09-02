import React from 'react'
import { ExternalLink, LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type {
  GitLabAssignableUser,
  GitLabPipelineJob,
  GitLabWorkItem,
  MRComment
} from '../../../shared/gitlab-types'

export type JobTraceState = {
  loading: boolean
  trace?: string
  error?: string
}

// Why: GitLab MR / issue states map onto a coarser palette than GitHub.
export const STATE_TONE: Record<GitLabWorkItem['state'], string> = {
  opened: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  closed: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  merged: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  locked: 'bg-rose-500/15 text-rose-700 dark:text-rose-300',
  draft: 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
}

// Why: pipeline job statuses map to one of four visual buckets — keep
// the mapping local so the renderer doesn't depend on the backend's
// shared mapper module (which is main-process only).
export function jobStatusTone(status: string): string {
  switch (status) {
    case 'success':
      return 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
    case 'failed':
      return 'bg-rose-500/15 text-rose-700 dark:text-rose-300'
    case 'running':
    case 'pending':
    case 'created':
    case 'preparing':
    case 'waiting_for_resource':
    case 'scheduled':
      return 'bg-sky-500/15 text-sky-700 dark:text-sky-300'
    case 'manual':
      return 'bg-amber-500/15 text-amber-700 dark:text-amber-300'
    case 'canceled':
    case 'skipped':
    default:
      return 'bg-muted text-muted-foreground'
  }
}

export function showGitLabMutationError(error: unknown): void {
  const message = error instanceof Error && error.message ? error.message : String(error)
  toast.error(
    message === 'undefined' || message === 'null'
      ? translate('auto.components.GitLabItemDialog.gitlabActionFailed', 'GitLab action failed.')
      : message
  )
}

export function StateBadge({ state }: { state: GitLabWorkItem['state'] }): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide',
        STATE_TONE[state]
      )}
    >
      {state}
    </span>
  )
}

export function normalizeGitLabLabels(labels: readonly string[]): string[] {
  const seen = new Set<string>()
  const normalized: string[] = []
  for (const label of labels) {
    const trimmed = label.trim()
    const key = trimmed.toLowerCase()
    if (!trimmed || seen.has(key)) {
      continue
    }
    seen.add(key)
    normalized.push(trimmed)
  }
  return normalized
}

export function parseGitLabLabelDraft(value: string): string[] {
  return normalizeGitLabLabels(value.split(','))
}

export function formatGitLabLabelDraft(labels: readonly string[]): string {
  return normalizeGitLabLabels(labels).join(', ')
}

export function toggleGitLabLabelDraft(value: string, label: string): string {
  const labels = parseGitLabLabelDraft(value)
  const key = label.trim().toLowerCase()
  const next = labels.some((item) => item.toLowerCase() === key)
    ? labels.filter((item) => item.toLowerCase() !== key)
    : [...labels, label]
  return formatGitLabLabelDraft(next)
}

export function gitLabUserKey(user: GitLabAssignableUser): string {
  return typeof user.id === 'number' ? `id:${user.id}` : `username:${user.username.toLowerCase()}`
}

export function dedupeGitLabUsers(users: readonly GitLabAssignableUser[]): GitLabAssignableUser[] {
  const byKey = new Map<string, GitLabAssignableUser>()
  for (const user of users) {
    byKey.set(gitLabUserKey(user), user)
  }
  return Array.from(byKey.values()).sort((a, b) => a.username.localeCompare(b.username))
}

export function CommentCard({
  comment,
  canResolve,
  resolving,
  onResolve
}: {
  comment: MRComment
  canResolve?: boolean
  resolving?: boolean
  onResolve?: (threadId: string, resolved: boolean) => void
}): React.JSX.Element {
  const hasThread = Boolean(comment.threadId)
  return (
    <div className="rounded-md border border-border/40 bg-muted/30 p-3">
      <div className="mb-1.5 flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <div className="flex items-center gap-2">
          {comment.authorAvatarUrl ? (
            <img
              src={comment.authorAvatarUrl}
              alt=""
              className="size-5 rounded-full"
              onError={(e) => {
                e.currentTarget.style.display = 'none'
              }}
            />
          ) : null}
          <span className="font-medium text-foreground">{comment.author}</span>
          {comment.isResolved ? (
            <span className="rounded-full bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
              {translate('auto.components.GitLabItemDialog.f23ea85341', 'resolved')}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {canResolve && hasThread && onResolve ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={resolving}
              onClick={() => onResolve(comment.threadId ?? '', !comment.isResolved)}
              className="h-6"
            >
              {resolving ? <LoaderCircle className="size-3 animate-spin" /> : null}
              {comment.isResolved
                ? translate('auto.components.GitLabItemDialog.65e784c1f1', 'Reopen')
                : translate('auto.components.GitLabItemDialog.4168eb2c51', 'Resolve')}
            </Button>
          ) : null}
          <span>{comment.createdAt ? new Date(comment.createdAt).toLocaleDateString() : ''}</span>
        </div>
      </div>
      {comment.path ? (
        <div className="mb-1.5 font-mono text-[11px] text-muted-foreground">
          {comment.path}
          {comment.line ? `:${comment.line}` : ''}
        </div>
      ) : null}
      <CommentMarkdown
        content={comment.body}
        variant="document"
        className="min-w-0 max-w-full overflow-hidden break-words text-[13px] leading-relaxed [&_a]:break-all [&_code]:break-words [&_pre]:max-w-full"
      />
    </div>
  )
}

export function PipelineJobRow({
  job,
  expanded,
  traceState,
  retrying,
  onToggleTrace,
  onRetry
}: {
  job: GitLabPipelineJob
  expanded: boolean
  traceState?: JobTraceState
  retrying: boolean
  onToggleTrace: (job: GitLabPipelineJob) => void
  onRetry: (job: GitLabPipelineJob) => void
}): React.JSX.Element {
  const canRetry = ['failed', 'canceled', 'cancelled'].includes(job.status)
  return (
    <div className="rounded-md">
      <div className="grid w-full grid-cols-[minmax(0,2fr)_minmax(0,1fr)_80px_64px_96px] items-center gap-3 px-3 py-2 text-left text-sm hover:bg-muted/40">
        <button
          type="button"
          onClick={() => onToggleTrace(job)}
          className="min-w-0 truncate text-left font-medium"
        >
          {job.name}
        </button>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{job.stage}</span>
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide',
            jobStatusTone(job.status)
          )}
        >
          {job.status}
        </span>
        <span className="text-right text-[11px] text-muted-foreground">
          {/* Why: durations come back as seconds; show "Nm Ns" for >60s
              and "Ns" otherwise. null = job hasn't finished. */}
          {typeof job.duration === 'number'
            ? job.duration >= 60
              ? `${Math.floor(job.duration / 60)}m ${Math.floor(job.duration % 60)}s`
              : `${Math.floor(job.duration)}s`
            : '—'}
        </span>
        <div className="flex justify-end gap-1">
          {canRetry ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={retrying}
              onClick={() => onRetry(job)}
              className="h-6"
            >
              {retrying ? <LoaderCircle className="size-3 animate-spin" /> : null}
              {translate('auto.components.GitLabItemDialog.fa3e042203', 'Retry')}
            </Button>
          ) : null}
          {job.webUrl ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => void window.api.shell.openUrl(job.webUrl)}
              title={translate('auto.components.GitLabItemDialog.032ae1312b', 'Open job in GitLab')}
            >
              <ExternalLink className="size-3" />
            </Button>
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className="mx-3 mb-2 rounded-md border border-border/50 bg-muted/20">
          <div className="flex items-center justify-between border-b border-border/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
            <span>{translate('auto.components.GitLabItemDialog.2f9b27f838', 'Job log')}</span>
            <Button type="button" variant="ghost" size="xs" onClick={() => onToggleTrace(job)}>
              {translate('auto.components.GitLabItemDialog.028bde664e', 'Hide')}
            </Button>
          </div>
          {traceState?.loading ? (
            <div className="flex items-center gap-2 px-2.5 py-3 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" />
              {translate('auto.components.GitLabItemDialog.d600c2619a', 'Loading log')}
            </div>
          ) : traceState?.error ? (
            <div className="px-2.5 py-3 text-xs text-destructive">{traceState.error}</div>
          ) : (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-2.5 py-2 font-mono text-[11px] leading-4 text-foreground scrollbar-sleek">
              {traceState?.trace?.trim()
                ? traceState.trace
                : translate('auto.components.GitLabItemDialog.32f8bef818', 'No log output.')}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  )
}
