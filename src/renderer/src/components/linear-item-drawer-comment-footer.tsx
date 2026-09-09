import React, { useCallback, useRef, useState } from 'react'
import { LoaderCircle, Send } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  getCommentBodySubmitState,
  hasBoundedCommentBodyText
} from '@/lib/comment-body-submit-state'
import { getScreenSubmitShortcutLabel, isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import { linearAddIssueComment } from '@/runtime/runtime-linear-issue-mutations'
import { translate } from '@/i18n/i18n'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { LinearLocalComment } from '@/components/linear-item-drawer-types'

export function LinearIssueCommentFooter({
  issueId,
  workspaceId,
  onCommentAdded,
  variant = 'compact',
  sourceContext
}: {
  issueId: string
  workspaceId?: string | null
  onCommentAdded: (comment: LinearLocalComment) => void
  variant?: 'compact' | 'linear-page'
  sourceContext?: TaskSourceContext | null
}): React.JSX.Element {
  const settings = useAppStore((s) => s.settings)
  const providerSettings = sourceContext ?? settings
  const submitShortcutLabel = getScreenSubmitShortcutLabel()
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mountedRef = useRef(true)

  const handleFooterRef = useCallback((node: HTMLDivElement | null): void => {
    // Why: comment submission can resolve after the footer unmounts; the root
    // ref keeps that completion from writing stale local state without an Effect.
    mountedRef.current = node !== null
  }, [])

  const autoGrow = useCallback(() => {
    const el = textareaRef.current
    if (!el) {
      return
    }
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`
  }, [])

  const handleSubmit = useCallback(async () => {
    const bodyState = getCommentBodySubmitState(body)
    if (bodyState.status === 'empty') {
      return
    }
    if (bodyState.status === 'too-large-leading-whitespace') {
      toast.error(
        translate(
          'auto.components.LinearItemDrawer.commentTooLarge',
          'Comment is too large to submit safely.'
        )
      )
      return
    }
    setSubmitting(true)
    try {
      const result = await linearAddIssueComment(
        providerSettings,
        issueId,
        bodyState.body,
        workspaceId
      )
      const typed = result as { ok: boolean; id?: string; error?: string }
      if (!mountedRef.current) {
        return
      }
      if (typed.ok) {
        setBody('')
        useAppStore.getState().recordFeatureInteraction('linear-tasks')
        onCommentAdded({
          id: typed.id ?? createBrowserUuid(),
          body: bodyState.body,
          createdAt: new Date().toISOString()
        })
      } else {
        toast.error(
          typed.error ??
            translate('auto.components.LinearItemDrawer.6ab35eafd5', 'Failed to add comment')
        )
      }
    } catch (err) {
      if (mountedRef.current) {
        toast.error(
          err instanceof Error
            ? err.message
            : translate('auto.components.LinearItemDrawer.6ab35eafd5', 'Failed to add comment')
        )
      }
    } finally {
      if (mountedRef.current) {
        setSubmitting(false)
      }
    }
  }, [body, issueId, onCommentAdded, providerSettings, workspaceId])
  const canSubmitComment = hasBoundedCommentBodyText(body)

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (isScreenSubmitShortcut(e)) {
        e.preventDefault()
        handleSubmit()
      }
    },
    [handleSubmit]
  )

  if (variant === 'linear-page') {
    return (
      <div
        ref={handleFooterRef}
        className="rounded-xl border border-border/70 bg-background shadow-xs"
      >
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
            autoGrow()
          }}
          onKeyDown={handleKeyDown}
          placeholder={translate(
            'auto.components.LinearItemDrawer.2820f0f0f0',
            'Leave a comment...'
          )}
          rows={3}
          className="scrollbar-sleek min-h-24 max-h-40 w-full resize-none overflow-y-auto rounded-t-xl bg-transparent px-5 py-4 text-sm placeholder:text-muted-foreground focus-visible:outline-none"
        />
        <div className="flex items-center justify-between px-4 pb-3">
          <span className="text-[11px] text-muted-foreground">
            {submitShortcutLabel !== 'Unassigned'
              ? translate('auto.components.LinearItemDrawer.fda549766e', '{{value0}} to comment', {
                  value0: submitShortcutLabel
                })
              : ''}
          </span>
          <Button
            size="icon-sm"
            onClick={handleSubmit}
            disabled={!canSubmitComment || submitting}
            aria-label={translate('auto.components.LinearItemDrawer.d369841269', 'Send comment')}
          >
            {submitting ? (
              <LoaderCircle className="size-3.5 animate-spin" />
            ) : (
              <Send className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={handleFooterRef}
      className="flex items-end gap-2 border-t border-border/60 bg-background/40 px-4 py-3"
    >
      <textarea
        ref={textareaRef}
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          autoGrow()
        }}
        onKeyDown={handleKeyDown}
        placeholder={translate('auto.components.LinearItemDrawer.2fcff829a8', 'Add a comment…')}
        rows={1}
        className="scrollbar-sleek min-h-[32px] max-h-[96px] flex-1 resize-none overflow-y-auto rounded-md border border-input bg-transparent px-3 py-2 text-[13px] placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
      <Button
        size="icon"
        onClick={handleSubmit}
        disabled={!canSubmitComment || submitting}
        className="size-8 shrink-0"
        aria-label={translate('auto.components.LinearItemDrawer.d369841269', 'Send comment')}
      >
        {submitting ? (
          <LoaderCircle className="size-3.5 animate-spin" />
        ) : (
          <Send className="size-3.5" />
        )}
      </Button>
    </div>
  )
}
