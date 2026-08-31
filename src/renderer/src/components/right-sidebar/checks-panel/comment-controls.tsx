import React, { useCallback, useRef, useState } from 'react'
import {
  Bot,
  Check,
  Copy,
  ExternalLink,
  MoreHorizontal,
  LoaderCircle,
  Pencil,
  Sparkles,
  Trash
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { isBotPRComment } from '../../../../../shared/pr-comment-audience'
import { setPRBotAuthorOverride } from '@/lib/pr-bot-author-overrides'
import { normalizePRCommentAuthorLogin } from '../../../../../shared/pr-bot-author-overrides'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { PRCommentGroupActionState } from '@/lib/pr-comment-action-state'
import type { PRCommentPresentationClasses } from '../pr-comment-presentation'
import { translate } from '@/i18n/i18n'

export function CopyButton({
  text,
  title = 'Copy comment'
}: {
  text: string
  title?: string
}): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  const copiedResetTimerRef = useRef<number | null>(null)
  // Why: clipboard IPC can resolve after this row action unmounts; avoid
  // starting a reset timer that will outlive the component.
  const isMountedRef = useRef(false)

  const clearCopiedResetTimer = useCallback((): void => {
    if (copiedResetTimerRef.current !== null) {
      window.clearTimeout(copiedResetTimerRef.current)
      copiedResetTimerRef.current = null
    }
  }, [])

  const setCopyButtonRef = useCallback(
    (node: HTMLButtonElement | null) => {
      isMountedRef.current = node !== null
      if (node === null) {
        clearCopiedResetTimer()
      }
    },
    [clearCopiedResetTimer]
  )

  const handleCopy = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      void window.api.ui.writeClipboardText(text).then(() => {
        if (!isMountedRef.current) {
          return
        }
        clearCopiedResetTimer()
        setCopied(true)
        copiedResetTimerRef.current = window.setTimeout(() => {
          copiedResetTimerRef.current = null
          setCopied(false)
        }, 1500)
      })
    },
    [clearCopiedResetTimer, text]
  )

  return (
    <button
      ref={setCopyButtonRef}
      className="p-1 rounded hover:bg-accent text-muted-foreground/40 hover:text-foreground transition-colors shrink-0"
      title={title}
      onClick={handleCopy}
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  )
}

export function ResolveButton({
  threadId,
  isResolved,
  onResolve
}: {
  threadId: string
  isResolved: boolean
  onResolve: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
}): React.JSX.Element {
  const [loading, setLoading] = useState(false)
  const loadingResetTimerRef = useRef<number | null>(null)

  const clearLoadingResetTimer = useCallback((): void => {
    if (loadingResetTimerRef.current !== null) {
      window.clearTimeout(loadingResetTimerRef.current)
      loadingResetTimerRef.current = null
    }
  }, [])

  const setResolveButtonRootRef = useCallback(
    (node: HTMLSpanElement | null) => {
      if (node === null) {
        clearLoadingResetTimer()
      }
    },
    [clearLoadingResetTimer]
  )

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation()
      clearLoadingResetTimer()
      setLoading(true)
      void Promise.resolve(onResolve(threadId, !isResolved)).finally(() => setLoading(false))
    },
    [clearLoadingResetTimer, threadId, isResolved, onResolve]
  )

  return (
    <span ref={setResolveButtonRootRef} className="contents">
      {loading ? (
        <LoaderCircle className="size-3 animate-spin text-muted-foreground shrink-0" />
      ) : (
        <button
          className="text-[10px] px-1.5 py-0.5 rounded transition-colors shrink-0 text-muted-foreground hover:text-foreground hover:bg-accent"
          onClick={handleClick}
        >
          {isResolved
            ? translate(
                'auto.components.right.sidebar.checks.panel.content.365254cc1b',
                'Unresolve'
              )
            : translate('auto.components.right.sidebar.checks.panel.content.0c96cd25e5', 'Resolve')}
        </button>
      )}
    </span>
  )
}

/** Format a line range string like "L12" or "L5-L12". */
export function formatLineRange(comment: PRComment): string | null {
  if (!comment.line) {
    return null
  }
  if (comment.startLine && comment.startLine !== comment.line) {
    return `L${comment.startLine}-L${comment.line}`
  }
  return `L${comment.line}`
}

/** True for top-level PR conversation comments the viewer can edit or delete. */
export function isMutablePRConversationComment(comment: PRComment): boolean {
  if (comment.threadId || comment.path) {
    return false
  }
  if (comment.url && comment.url.includes('pullrequestreview')) {
    return false
  }
  return Number.isSafeInteger(comment.id) && comment.id > 0
}

export function CommentMoreMenu({
  comment,
  botAuthorOverrides,
  onStartEdit,
  onDelete,
  onQueueForAgent
}: {
  comment: PRComment
  botAuthorOverrides: ReadonlySet<string>
  onStartEdit?: () => void
  onDelete?: () => void | Promise<void>
  onQueueForAgent?: () => void
}): React.JSX.Element | null {
  const authorLogin = normalizePRCommentAuthorLogin(comment.author)
  const isOverriddenBot = authorLogin.length > 0 && botAuthorOverrides.has(authorLogin)
  // Why: the override is an escape hatch for bots the heuristics miss, so hide
  // the action when the author is already detected as a bot without it.
  const hasMarkAsBot = authorLogin.length > 0 && (isOverriddenBot || !isBotPRComment(comment))
  const hasGoToComment = Boolean(comment.url)
  const hasEdit = Boolean(onStartEdit)
  const hasDelete = Boolean(onDelete)
  const hasQueue = Boolean(onQueueForAgent)
  if (!hasGoToComment && !hasEdit && !hasDelete && !hasQueue && !hasMarkAsBot) {
    return null
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.checks.panel.content.74c6885b8a',
            'More comment actions'
          )}
          title={translate('auto.components.right.sidebar.checks.panel.content.1abb17aac9', 'More')}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        {hasQueue ? (
          <DropdownMenuItem onSelect={() => onQueueForAgent?.()}>
            <Sparkles />
            {translate(
              'auto.components.right.sidebar.checks.panel.content.f8a2c91d04',
              'Queue for agent'
            )}
          </DropdownMenuItem>
        ) : null}
        {hasQueue && (hasGoToComment || hasEdit || hasDelete) ? <DropdownMenuSeparator /> : null}
        {hasGoToComment && (
          <DropdownMenuItem onSelect={() => window.api.shell.openUrl(comment.url)}>
            <ExternalLink />
            {translate(
              'auto.components.right.sidebar.checks.panel.content.d3923d18fe',
              'Go to comment'
            )}
          </DropdownMenuItem>
        )}
        {hasGoToComment && (hasEdit || hasDelete) ? <DropdownMenuSeparator /> : null}
        {hasEdit ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onStartEdit?.()
            }}
          >
            <Pencil />
            {translate('auto.components.right.sidebar.checks.panel.content.03ca88f623', 'Edit')}
          </DropdownMenuItem>
        ) : null}
        {hasDelete ? (
          <DropdownMenuItem variant="destructive" onSelect={() => void onDelete?.()}>
            <Trash />
            {translate('auto.components.right.sidebar.checks.panel.content.6cc6eace26', 'Delete')}
          </DropdownMenuItem>
        ) : null}
        {hasMarkAsBot ? (
          <>
            {(hasQueue || hasGoToComment || hasEdit || hasDelete) && <DropdownMenuSeparator />}
            <DropdownMenuItem
              onSelect={() => setPRBotAuthorOverride(comment.author, !isOverriddenBot)}
            >
              <Bot />
              {isOverriddenBot
                ? translate(
                    'auto.components.right.sidebar.checks.panel.content.b3195cba33',
                    'Unmark author as bot'
                  )
                : translate(
                    'auto.components.right.sidebar.checks.panel.content.f588b46a6c',
                    'Mark author as bot'
                  )}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Build copy text that includes file location context for review comments. */
export function buildCopyText(comment: PRComment): string {
  if (!comment.path) {
    return comment.body
  }
  const lineRange = formatLineRange(comment)
  const location = lineRange ? `${comment.path}:${lineRange}` : comment.path
  return `File: ${location}\n\n${comment.body}`
}

export function QueueForAgentButton({
  className,
  onQueueForAgent
}: {
  className?: string
  onQueueForAgent: () => void
}): React.JSX.Element {
  const label = translate(
    'auto.components.right.sidebar.checks.panel.content.f8a2c91d04',
    'Queue for agent'
  )
  // Why: always-visible row action, but ghost styling keeps it from reading as a card-level CTA.
  return (
    <button
      type="button"
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-[background-color,color,opacity] hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
        className
      )}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation()
        onQueueForAgent()
      }}
    >
      <Sparkles className="size-3 shrink-0" />
      {translate('auto.components.right.sidebar.checks.panel.content.a7f0c7e8d1', 'Queue')}
    </button>
  )
}

export function PRCommentActionBadge({
  actionState,
  isQueued,
  presentation
}: {
  actionState: PRCommentGroupActionState
  isQueued: boolean
  presentation: PRCommentPresentationClasses
}): React.JSX.Element | null {
  if (isQueued) {
    return (
      <span className={presentation.statusBadgeQueued}>
        {translate('auto.components.right.sidebar.checks.panel.content.b4e8a1c902', 'Queued')}
      </span>
    )
  }
  if (actionState === 'resolved') {
    return (
      <span className={presentation.statusBadgeResolved}>
        {translate('auto.components.right.sidebar.checks.panel.content.8987d5a3dd', 'Resolved')}
      </span>
    )
  }
  return null
}
