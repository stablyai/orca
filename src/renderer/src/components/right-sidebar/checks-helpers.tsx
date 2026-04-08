/* eslint-disable max-lines -- Why: co-locating all checks-panel sub-components (checks list,
conflict sections, threaded PR comments) keeps the shared icon/color maps in one place. */
import React, { useCallback, useState } from 'react'
import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  CircleDashed,
  CircleMinus,
  GitPullRequest,
  Files,
  Copy,
  Check,
  MessageSquare
} from 'lucide-react'
import { ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { PRInfo, PRCheckDetail, PRComment } from '../../../../shared/types'

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

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void window.api.ui.writeClipboardText(text).then(() => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      })
    },
    [text]
  )

  return (
    <button
      className="p-1 rounded hover:bg-accent text-muted-foreground/40 hover:text-foreground transition-colors shrink-0"
      title="Copy comment"
      onClick={handleCopy}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

function ResolveButton({
  threadId,
  isResolved,
  onResolve
}: {
  threadId: string
  isResolved: boolean
  onResolve: (threadId: string, resolve: boolean) => void
}): React.JSX.Element {
  const [loading, setLoading] = useState(false)

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      setLoading(true)
      onResolve(threadId, !isResolved)
      setTimeout(() => setLoading(false), 300)
    },
    [threadId, isResolved, onResolve]
  )

  if (loading) {
    return <LoaderCircle className="size-3 animate-spin text-muted-foreground shrink-0" />
  }

  return (
    <button
      className="text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent"
      onClick={handleClick}
    >
      {isResolved ? 'Unresolve' : 'Resolve'}
    </button>
  )
}

/** Format a line range string like "L12" or "L5-L12". */
function formatLineRange(comment: PRComment): string | null {
  if (!comment.line) {
    return null
  }
  if (comment.startLine && comment.startLine !== comment.line) {
    return `L${comment.startLine}-L${comment.line}`
  }
  return `L${comment.line}`
}

/** Build copy text that includes file location context for review comments. */
function buildCopyText(comment: PRComment): string {
  if (!comment.path) {
    return comment.body
  }
  const lineRange = formatLineRange(comment)
  const location = lineRange ? `${comment.path}:${lineRange}` : comment.path
  return `File: ${location}\n\n${comment.body}`
}

/** A single comment row — used for both root and reply comments. */
function CommentRow({
  comment,
  isReply,
  showResolve,
  onResolve
}: {
  comment: PRComment
  isReply: boolean
  showResolve: boolean
  onResolve?: (threadId: string, resolve: boolean) => void
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex items-start gap-2 py-1.5 hover:bg-accent/40 transition-colors cursor-pointer group/comment',
        isReply ? 'pl-7 pr-3' : 'px-3',
        comment.isResolved && 'opacity-50'
      )}
      onClick={() => {
        if (comment.url) {
          window.api.shell.openUrl(comment.url)
        }
      }}
    >
      <div className="flex-1 min-w-0">
        {/* Author line: avatar + name + file badge aligned on center */}
        <div className="flex items-center gap-1.5 min-w-0">
          {comment.authorAvatarUrl ? (
            <img
              src={comment.authorAvatarUrl}
              alt={comment.author}
              className={cn('rounded-full shrink-0', isReply ? 'size-3.5' : 'size-4')}
            />
          ) : (
            <div
              className={cn('rounded-full bg-muted shrink-0', isReply ? 'size-3.5' : 'size-4')}
            />
          )}
          <span
            className={cn(
              'text-[11px] font-semibold shrink-0',
              comment.isResolved ? 'text-muted-foreground' : 'text-foreground'
            )}
          >
            {comment.author}
          </span>
          {!isReply && comment.path && (
            <span className="text-[10px] font-mono text-muted-foreground/60 truncate min-w-0">
              {comment.path.split('/').pop()}
              {formatLineRange(comment) && `:${formatLineRange(comment)}`}
            </span>
          )}
          <div className="flex-1" />
          <div className="flex items-center gap-0.5 opacity-0 group-hover/comment:opacity-100 transition-opacity">
            {showResolve && comment.threadId != null && onResolve && (
              <ResolveButton
                threadId={comment.threadId}
                isResolved={comment.isResolved ?? false}
                onResolve={onResolve}
              />
            )}
            <CopyButton text={buildCopyText(comment)} />
          </div>
        </div>
        {/* Comment body */}
        <p
          className={cn(
            'text-[11px] text-muted-foreground leading-snug mt-0.5',
            isReply ? 'pl-5 line-clamp-1' : 'pl-[22px] line-clamp-2'
          )}
        >
          {comment.body}
        </p>
      </div>
    </div>
  )
}

/** Group structure for organizing comments by thread. */
type CommentGroup =
  | { kind: 'standalone'; comment: PRComment }
  | { kind: 'thread'; threadId: string; root: PRComment; replies: PRComment[] }

/** Groups comments by threadId. Comments without a threadId are standalone. */
function groupComments(comments: PRComment[]): CommentGroup[] {
  const groups: CommentGroup[] = []
  const threadMap = new Map<string, { root: PRComment; replies: PRComment[] }>()
  // Why: preserve insertion order so threads appear in the order their first
  // comment was created (the comments array is already sorted by createdAt).
  const threadOrder: string[] = []

  for (const comment of comments) {
    if (!comment.threadId) {
      groups.push({ kind: 'standalone', comment })
      continue
    }
    const existing = threadMap.get(comment.threadId)
    if (existing) {
      existing.replies.push(comment)
    } else {
      threadMap.set(comment.threadId, { root: comment, replies: [] })
      threadOrder.push(comment.threadId)
    }
  }

  // Interleave threads at the position of their first comment.
  // Walk the original comment list and emit each thread/standalone once.
  const emitted = new Set<string>()
  const result: CommentGroup[] = []
  for (const comment of comments) {
    if (!comment.threadId) {
      result.push({ kind: 'standalone', comment })
    } else if (!emitted.has(comment.threadId)) {
      emitted.add(comment.threadId)
      const thread = threadMap.get(comment.threadId)!
      result.push({ kind: 'thread', threadId: comment.threadId, ...thread })
    }
  }
  return result
}

/** Renders the PR comments section below checks. */
export function PRCommentsList({
  comments,
  commentsLoading,
  onResolve
}: {
  comments: PRComment[]
  commentsLoading: boolean
  onResolve?: (threadId: string, resolve: boolean) => void
}): React.JSX.Element {
  const groups = React.useMemo(() => groupComments(comments), [comments])

  return (
    <div className="border-t border-border">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border">
        <MessageSquare className="size-3.5 text-muted-foreground" />
        <span className="text-[11px] font-medium text-foreground">Comments</span>
        {comments.length > 0 && (
          <span className="text-[10px] text-muted-foreground">{comments.length}</span>
        )}
      </div>

      {/* List */}
      {commentsLoading && comments.length === 0 ? (
        <div className="flex items-center justify-center py-6">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-[11px] text-muted-foreground">
          No comments
        </div>
      ) : (
        <div className="py-1">
          {groups.map((group) => {
            if (group.kind === 'standalone') {
              return (
                <CommentRow
                  key={group.comment.id}
                  comment={group.comment}
                  isReply={false}
                  showResolve={false}
                  onResolve={onResolve}
                />
              )
            }
            return (
              <div key={group.threadId} className="py-0.5">
                <CommentRow
                  comment={group.root}
                  isReply={false}
                  showResolve={true}
                  onResolve={onResolve}
                />
                {group.replies.length > 0 && (
                  <div className="ml-3 border-l-2 border-border/50">
                    {group.replies.map((reply) => (
                      <CommentRow
                        key={reply.id}
                        comment={reply}
                        isReply={true}
                        showResolve={false}
                        onResolve={onResolve}
                      />
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
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
