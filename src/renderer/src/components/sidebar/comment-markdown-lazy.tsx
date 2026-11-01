import React from 'react'
import { cn } from '@/lib/utils'
import { lazyWithRetry } from '@/lib/lazy-with-retry'

// Share one lazy identity/chunk so Markdown dependencies stay off the boot graph for both sidebar surfaces.
const LazyCommentMarkdown = lazyWithRetry(() => import('./CommentMarkdown'), {
  reloadKey: 'comment-markdown'
})

/** Warm the chunk before use to reduce fallback time. */
export function preloadCommentMarkdown(): void {
  void import('./CommentMarkdown')
}

type CommentMarkdownAsyncProps = React.ComponentProps<typeof LazyCommentMarkdown> & {
  /** Extra classes for the pre-load fallback only, e.g. to mirror remark-breaks. */
  fallbackClassName?: string
}

/** Match raw-text fallback width/wrapping to the loaded renderer to limit layout shifts. */
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
