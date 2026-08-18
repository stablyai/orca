import React, { useCallback, useId, useMemo, useState } from 'react'
import { cn } from '@/lib/utils'
import { filterGitHubMentionOptions } from '@/components/github/github-mention-option-filter'
import type { MentionOption, MentionQuery } from '../page-types'
import { findMentionQuery } from './query'

export function MentionTextarea({
  value,
  onValueChange,
  onKeyDown,
  placeholder,
  rows,
  className,
  wrapperClassName,
  mentionOptions,
  textareaRef
}: {
  value: string
  onValueChange: (value: string) => void
  onKeyDown?: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  placeholder: string
  rows: number
  className?: string
  wrapperClassName?: string
  mentionOptions: MentionOption[]
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const listboxId = useId()
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const suggestions = useMemo(
    () => (mentionQuery ? filterGitHubMentionOptions(mentionOptions, mentionQuery.query) : []),
    [mentionOptions, mentionQuery]
  )
  const showSuggestions = mentionQuery !== null && suggestions.length > 0

  const syncMentionQuery = useCallback((textarea: HTMLTextAreaElement): void => {
    const nextQuery = findMentionQuery(textarea.value, textarea.selectionStart)
    setMentionQuery(nextQuery)
    setActiveIndex(0)
  }, [])

  const insertMention = useCallback(
    (option: MentionOption): void => {
      const textarea = textareaRef.current
      const caret = textarea?.selectionStart ?? value.length
      const query = textarea ? findMentionQuery(value, caret) : mentionQuery
      if (!query) {
        return
      }
      const suffix = value[caret] && !/\s/.test(value[caret]) ? ' ' : ''
      const inserted = `@${option.login}${suffix}`
      const nextValue = `${value.slice(0, query.atIndex)}${inserted}${value.slice(caret)}`
      const nextCaret = query.atIndex + inserted.length
      onValueChange(nextValue)
      setMentionQuery(null)
      requestAnimationFrame(() => {
        textarea?.focus()
        textarea?.setSelectionRange(nextCaret, nextCaret)
      })
    },
    [mentionQuery, onValueChange, textareaRef, value]
  )

  return (
    <div className={cn('relative min-w-0 flex-1', wrapperClassName)}>
      {showSuggestions && (
        <div
          id={listboxId}
          role="listbox"
          className="absolute right-0 bottom-[calc(100%+6px)] left-0 z-50 max-h-64 overflow-y-auto rounded-md border border-border/70 bg-popover p-1 text-popover-foreground shadow-lg scrollbar-sleek"
        >
          {suggestions.map((option, index) => (
            <button
              key={option.login}
              id={`${listboxId}-${index}`}
              role="option"
              aria-selected={index === activeIndex}
              type="button"
              onMouseDown={(event) => {
                event.preventDefault()
                insertMention(option)
              }}
              className={cn(
                'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px]',
                index === activeIndex && 'bg-accent text-accent-foreground'
              )}
            >
              {option.avatarUrl ? (
                <img src={option.avatarUrl} alt="" className="size-5 shrink-0 rounded-full" />
              ) : (
                <div className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
                  {option.login.slice(0, 1).toUpperCase()}
                </div>
              )}
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <span className="shrink-0 font-medium">@{option.login}</span>
                {option.name && (
                  <>
                    <span className="shrink-0 text-muted-foreground">|</span>
                    <span className="truncate text-muted-foreground">{option.name}</span>
                  </>
                )}
                <span className="shrink-0 text-muted-foreground">|</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{option.source}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        role="combobox"
        aria-expanded={showSuggestions}
        aria-controls={showSuggestions ? listboxId : undefined}
        aria-activedescendant={showSuggestions ? `${listboxId}-${activeIndex}` : undefined}
        value={value}
        onChange={(event) => {
          onValueChange(event.target.value)
          syncMentionQuery(event.currentTarget)
        }}
        onClick={(event) => syncMentionQuery(event.currentTarget)}
        onKeyUp={(event) => {
          if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) {
            syncMentionQuery(event.currentTarget)
          }
        }}
        onBlur={() => setMentionQuery(null)}
        onKeyDown={(event) => {
          if (showSuggestions) {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              setActiveIndex((current) => (current + 1) % suggestions.length)
              return
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActiveIndex((current) => (current - 1 + suggestions.length) % suggestions.length)
              return
            }
            if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              insertMention(suggestions[activeIndex] ?? suggestions[0])
              return
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              setMentionQuery(null)
              return
            }
          }
          onKeyDown?.(event)
        }}
        placeholder={placeholder}
        rows={rows}
        className={className}
      />
    </div>
  )
}
