import type { CommentMarkdownLinkClickHandler } from '@/components/sidebar/CommentMarkdown'
import { cn } from '@/lib/utils'
import { createNativeChatFileHref } from '../../../../shared/native-chat-href-routing'

/** The file a tool row names: its base name on screen, the full path in its title and
 *  accessible name. With a link handler it opens the file in Orca instead of toggling the row. */
export function NativeChatToolFileTarget({
  path,
  label,
  className,
  onLinkClick
}: {
  path: string
  label: string
  className: string
  onLinkClick?: CommentMarkdownLinkClickHandler
}): React.JSX.Element {
  if (!onLinkClick) {
    return (
      <>
        <span className={className} title={path} aria-hidden="true">
          {label}
        </span>
        <span className="sr-only">{path}</span>
      </>
    )
  }
  return (
    <span
      role="link"
      tabIndex={0}
      className={cn(
        className,
        'cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      title={path}
      aria-label={path}
      onClick={(event) => {
        // The row around this is its expand button; opening the file must not also toggle it.
        event.stopPropagation()
        onLinkClick(event, createNativeChatFileHref(path, 'literal'))
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          event.currentTarget.dispatchEvent(
            new MouseEvent('click', {
              bubbles: true,
              cancelable: true,
              detail: 0,
              altKey: event.altKey,
              ctrlKey: event.ctrlKey,
              metaKey: event.metaKey,
              shiftKey: event.shiftKey
            })
          )
        }
      }}
    >
      {label}
    </span>
  )
}
