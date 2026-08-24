import React from 'react'
import type { Components } from 'react-markdown'
import { translate } from '@/i18n/i18n'

// Why: react-markdown sets className="language-suggestion" on the <code> inside
// a fenced ```suggestion block — GitHub's applicable-suggestion syntax. We render
// it as a small read-only diff (current range vs suggested text) instead of a
// plain code block, mirroring github.com.

export type CommentSuggestionOptions = {
  /** Current text of the commented range; renders as the removed side when present. */
  originalLines?: string[]
}

export function isSuggestionFence(className: string | undefined): boolean {
  return /\blanguage-suggestion\b/.test(className ?? '')
}

// Why: the suggestion block renders <div>s (headers, buttons), which are invalid
// inside <pre>; the pre renderer must unwrap exactly like the mermaid fence does.
export function isSuggestionPre(children: React.ReactNode): boolean {
  const child = React.Children.toArray(children)[0]
  if (!React.isValidElement(child)) {
    return false
  }
  const className = (child.props as { className?: string } | null)?.className
  return isSuggestionFence(className)
}

export function CommentSuggestionBlock({
  suggestionText,
  options
}: {
  suggestionText: string
  options?: CommentSuggestionOptions
}): React.JSX.Element {
  const suggestedLines = suggestionText.length === 0 ? [] : suggestionText.split('\n')
  return (
    <div className="my-1.5 min-w-0 max-w-full overflow-hidden rounded-md border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-muted/50 px-2 py-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          {translate('auto.components.sidebar.commentSuggestionFence.header', 'Suggested change')}
        </span>
      </div>
      <div className="max-h-60 overflow-x-auto font-mono text-[11px] leading-5">
        {(options?.originalLines ?? []).map((line, index) => (
          <div
            key={`old-${String(index)}`}
            className="whitespace-pre px-2 text-muted-foreground line-through"
            style={{
              background: 'color-mix(in srgb, var(--git-decoration-deleted) 12%, transparent)'
            }}
          >
            {line || ' '}
          </div>
        ))}
        {suggestedLines.map((line, index) => (
          <div
            key={`new-${String(index)}`}
            className="whitespace-pre px-2"
            style={{
              background: 'color-mix(in srgb, var(--git-decoration-added) 12%, transparent)'
            }}
          >
            {line || ' '}
          </div>
        ))}
        {suggestedLines.length === 0 ? (
          <div className="px-2 italic text-muted-foreground">
            {translate(
              'auto.components.sidebar.commentSuggestionFence.removalOnly',
              'Suggestion removes these lines.'
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/** Wrap a components map so ```suggestion fences render as diff previews; other fences fall through. */
export function withSuggestionFenceComponents(
  base: Components,
  options?: CommentSuggestionOptions
): Components {
  const BaseCode = base.code
  const BasePre = base.pre
  return {
    ...base,
    code: (props) => {
      const { className, children } = props
      if (isSuggestionFence(className)) {
        // Why: an empty fence (removal-only suggestion) yields NO children — String(undefined)
        // would render and apply the literal "undefined". Trailing newline is fence formatting.
        const text = React.Children.toArray(children)
          .filter((child) => typeof child === 'string' || typeof child === 'number')
          .join('')
          .replace(/\n$/, '')
        return <CommentSuggestionBlock suggestionText={text} options={options} />
      }
      return typeof BaseCode === 'function' ? (
        <BaseCode {...props} />
      ) : (
        <code className={className}>{children}</code>
      )
    },
    pre: (props) => {
      const { children } = props
      if (isSuggestionPre(children)) {
        return <>{children}</>
      }
      return typeof BasePre === 'function' ? <BasePre {...props} /> : <pre>{children}</pre>
    }
  }
}
