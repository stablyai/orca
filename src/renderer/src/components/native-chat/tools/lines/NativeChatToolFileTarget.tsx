import { cn } from '@/lib/class-names'
import { createNativeChatFileHref } from '../../../../../../shared/native-chat/native-chat-href-routing'
import { useNativeChatLinkClick } from '../../links/actions/native-chat-link-click-context'

/** Expose the full path accessibly; a link handler opens the file without toggling its row. */
export function NativeChatToolFileTarget({
  path,
  label,
  className,
  openable = true
}: {
  path: string
  label: string
  className: string
  /** False when there is nothing left to open, such as a deleted file. */
  openable?: boolean
}): React.JSX.Element {
  const chatLinkClick = useNativeChatLinkClick()
  const onLinkClick = openable ? chatLinkClick : undefined
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
  const href = createNativeChatFileHref(path, 'literal')
  return (
    <span
      role="link"
      tabIndex={0}
      data-native-chat-link-href={href}
      className={cn(
        className,
        'cursor-pointer rounded-sm underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'
      )}
      title={path}
      aria-label={path}
      onClick={(event) => {
        // The row around this is its expand button; opening the file must not also toggle it.
        event.stopPropagation()
        onLinkClick(event, href)
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
