import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Bold, Code2, Italic, List, Quote } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { cn } from '@/lib/utils'
import {
  clearRightPanelCommentFocusTimer,
  scheduleRightPanelCommentFocusTimer
} from './right-panel-comment-focus-timers'
import { translate } from '@/i18n/i18n'

export type RightPanelCommentSubmitResult = { ok: true } | { ok: false; error: string }

type MarkdownAction = 'bold' | 'italic' | 'code' | 'quote' | 'list'

type RightPanelCommentComposerProps = {
  placeholder: string
  submitLabel: string
  onSubmit: (body: string) => Promise<RightPanelCommentSubmitResult>
  disabled?: boolean
  disabledReason?: string
  autoFocus?: boolean
  className?: string
  onCancel?: () => void
}

function applyMarkdownAction(value: string, start: number, end: number, action: MarkdownAction) {
  const selected = value.slice(start, end)
  switch (action) {
    case 'bold':
      return {
        value: `${value.slice(0, start)}**${selected || 'strong text'}**${value.slice(end)}`,
        selectionStart: start + 2,
        selectionEnd: start + 2 + (selected || 'strong text').length
      }
    case 'italic':
      return {
        value: `${value.slice(0, start)}_${selected || 'emphasis'}_${value.slice(end)}`,
        selectionStart: start + 1,
        selectionEnd: start + 1 + (selected || 'emphasis').length
      }
    case 'code':
      return {
        value: `${value.slice(0, start)}\`${selected || 'code'}\`${value.slice(end)}`,
        selectionStart: start + 1,
        selectionEnd: start + 1 + (selected || 'code').length
      }
    case 'quote': {
      const prefix = start === 0 || value[start - 1] === '\n' ? '> ' : '\n> '
      return {
        value: `${value.slice(0, start)}${prefix}${selected || 'quote'}${value.slice(end)}`,
        selectionStart: start + prefix.length,
        selectionEnd: start + prefix.length + (selected || 'quote').length
      }
    }
    case 'list': {
      const prefix = start === 0 || value[start - 1] === '\n' ? '- ' : '\n- '
      return {
        value: `${value.slice(0, start)}${prefix}${selected || 'item'}${value.slice(end)}`,
        selectionStart: start + prefix.length,
        selectionEnd: start + prefix.length + (selected || 'item').length
      }
    }
  }
}

export function RightPanelCommentComposer({
  placeholder,
  submitLabel,
  onSubmit,
  disabled,
  disabledReason,
  autoFocus,
  className,
  onCancel
}: RightPanelCommentComposerProps): React.JSX.Element {
  const [body, setBody] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const autoFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isMac = navigator.userAgent.includes('Mac')

  useEffect(() => {
    const textarea = textareaRef.current
    if (!textarea) {
      return
    }
    textarea.style.height = '0px'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`
  }, [body])

  useEffect(() => {
    if (!autoFocus) {
      clearRightPanelCommentFocusTimer(autoFocusTimerRef)
      return
    }
    scheduleRightPanelCommentFocusTimer(autoFocusTimerRef, () => textareaRef.current?.focus())
    return () => clearRightPanelCommentFocusTimer(autoFocusTimerRef)
  }, [autoFocus])

  const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
    if (node === null) {
      // Why: markdown toolbar selection restoration is scoped to this textarea;
      // clearing here prevents stale focus after the composer unmounts.
      clearRightPanelCommentFocusTimer(selectionTimerRef)
    }
  }, [])

  const stopPropagation = useCallback((event: React.SyntheticEvent) => {
    event.stopPropagation()
  }, [])

  const applyAction = useCallback(
    (action: MarkdownAction) => {
      const textarea = textareaRef.current
      if (!textarea) {
        return
      }
      const next = applyMarkdownAction(body, textarea.selectionStart, textarea.selectionEnd, action)
      setBody(next.value)
      scheduleRightPanelCommentFocusTimer(selectionTimerRef, () => {
        if (!textarea.isConnected) {
          return
        }
        textarea.focus()
        textarea.setSelectionRange(next.selectionStart, next.selectionEnd)
      })
    },
    [body]
  )

  const submit = useCallback(async () => {
    const trimmed = body.trim()
    if (!trimmed || submitting || disabled) {
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const result = await onSubmit(trimmed)
      if (result.ok) {
        setBody('')
        onCancel?.()
      } else {
        setError(result.error)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to post comment.')
    } finally {
      setSubmitting(false)
    }
  }, [body, disabled, onCancel, onSubmit, submitting])

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const modifierPressed = isMac ? event.metaKey : event.ctrlKey
      if (event.key === 'Enter' && modifierPressed) {
        event.preventDefault()
        void submit()
      }
    },
    [isMac, submit]
  )

  const toolbar = [
    { action: 'bold' as const, label: translate("auto.components.right.sidebar.right.panel.comment.composer.256300f8ea", "Bold"), icon: Bold },
    { action: 'italic' as const, label: translate("auto.components.right.sidebar.right.panel.comment.composer.542bf6a7e2", "Italic"), icon: Italic },
    { action: 'code' as const, label: translate("auto.components.right.sidebar.right.panel.comment.composer.f49e0a21e0", "Code"), icon: Code2 },
    { action: 'quote' as const, label: translate("auto.components.right.sidebar.right.panel.comment.composer.d6d9c3c947", "Quote"), icon: Quote },
    { action: 'list' as const, label: translate("auto.components.right.sidebar.right.panel.comment.composer.cf5a7aba6f", "List"), icon: List }
  ]

  return (
    <div
      className={cn(
        'min-w-0 overflow-hidden rounded-md border border-border bg-background',
        className
      )}
      onClick={stopPropagation}
      onMouseDown={stopPropagation}
    >
      <textarea
        ref={setTextareaRef}
        value={body}
        rows={3}
        className="block max-h-44 min-h-20 w-full min-w-0 resize-none bg-transparent px-2.5 py-2 text-[12px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-60"
        placeholder={placeholder}
        disabled={disabled || submitting}
        aria-invalid={Boolean(error)}
        title={disabled ? disabledReason : undefined}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={handleKeyDown}
        onClick={stopPropagation}
      />
      <div className="flex min-w-0 items-center gap-0.5 border-t border-border px-2 py-1">
        {toolbar.map(({ action, label, icon: Icon }) => (
          <Tooltip key={action}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={label}
                disabled={disabled || submitting}
                onClick={() => applyAction(action)}
              >
                <Icon className="size-3" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {label}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
      {error && (
        <div className="border-t border-border px-2.5 py-1.5 text-[11px] text-destructive">
          {error}
        </div>
      )}
      <div className="flex min-w-0 items-center justify-end gap-1 border-t border-border px-2 py-1.5">
        {onCancel && (
          <Button type="button" variant="ghost" size="xs" disabled={submitting} onClick={onCancel}>
            {translate("auto.components.right.sidebar.right.panel.comment.composer.9bca633dee", "Cancel")}</Button>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              size="xs"
              aria-label={submitLabel}
              disabled={disabled || submitting || body.trim().length === 0}
              onClick={() => void submit()}
            >
              {submitting ? translate("auto.components.right.sidebar.right.panel.comment.composer.87aff03d63", "Sending...") : submitLabel}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            {disabled && disabledReason ? (
              <span>{disabledReason}</span>
            ) : (
              <span className="flex items-center gap-2">
                <span>{submitLabel}</span>
                <ShortcutKeyCombo
                  keys={[isMac ? '⌘' : 'Ctrl', 'Enter']}
                  className="shrink text-[10px] [&_span]:min-w-0 [&_span]:px-1"
                  separatorClassName="mx-0 text-[10px] text-muted-foreground"
                />
              </span>
            )}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  )
}
