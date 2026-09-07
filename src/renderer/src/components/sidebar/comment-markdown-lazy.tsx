import React from 'react'
import { cn } from '@/lib/utils'
import { lazyWithRetry } from '@/lib/lazy-with-retry'

// Boot-path split: react-markdown + remark/rehype/DOMPurify is ~356 KB of JS that
// only the sidebar's two markdown surfaces pull onto the eager graph. One lazy()
// identity for both, so they share a component type and a single chunk fetch.
const LazyCommentMarkdown = lazyWithRetry(() => import('./CommentMarkdown'), {
  reloadKey: 'comment-markdown'
})

/** Warms the chunk ahead of render so the fallback is never actually shown. */
export function preloadCommentMarkdown(): void {
  void import('./CommentMarkdown')
}

type CommentMarkdownAsyncProps = React.ComponentProps<typeof LazyCommentMarkdown> & {
  /** Extra classes for the pre-load fallback only, e.g. to mirror remark-breaks. */
  fallbackClassName?: string
}

/**
 * Renders the markdown body, falling back to the raw text in an identically
 * classed box while the chunk loads — same width and wrapping constraints, so a
 * paint before the chunk lands cannot shift layout.
 */
export function CommentMarkdownAsync({
  fallbackClassName,
  ...props
}: CommentMarkdownAsyncProps): React.JSX.Element {
  return (
    <React.Suspense
      fallback={
        <div
          className={cn(
            'min-w-0 max-w-full [overflow-wrap:anywhere]',
            props.className,
            fallbackClassName
          )}
          title={props.title}
        >
          {props.content}
        </div>
      }
    >
      <LazyCommentMarkdown {...props} />
    </React.Suspense>
  )
}
