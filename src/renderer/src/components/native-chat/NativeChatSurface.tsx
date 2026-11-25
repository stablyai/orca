import type { ReactNode } from 'react'
import { cn } from '@/lib/class-names'
import { LinkActionPopover } from '@/components/link-actions/LinkActionPopover'
import { NATIVE_CHAT_APPEARANCE_ROOT_CLASS } from './appearance/native-chat-appearance-style'
import { NativeChatFindBar } from './viewport/find/NativeChatFindBar'
import { NativeChatFindQueryContext } from './viewport/find/native-chat-find-query'
import { NativeChatSessionHistoryScopeContext } from './native-chat-session-history-scope'
import { NativeChatLinkClickContext } from './links/actions/native-chat-link-click-context'
import type { NativeChatSurfaceState } from './use-native-chat-surface'
import { NativeChatVideoNotesHost } from './media/notes/video/NativeChatVideoNotesHost'

/** Every chat screen's root: the surface's handlers, appearance, context menu, link popover, and
 *  the link handler its rows read, and the Session History its composer's `/resume` opens. */
export function NativeChatSurface({
  surface,
  working,
  children,
  className,
  ...dataAttributes
}: {
  surface: NativeChatSurfaceState
  working: boolean
  children: ReactNode
  /** Extra root classes, e.g. the size container a structured chat's worker dock measures. */
  className?: string
} & Record<`data-${string}`, string | undefined>): React.JSX.Element {
  return (
    <div
      ref={surface.rootRef}
      data-native-chat-root="true"
      data-native-chat-working={working ? 'true' : 'false'}
      tabIndex={-1}
      {...dataAttributes}
      {...surface.rootProps}
      className={cn(
        NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
        'flex h-full min-h-0 w-full flex-col focus:outline-none',
        className
      )}
      style={surface.appearance}
      data-native-chat-scheme={surface.appearance.colorScheme}
    >
      <NativeChatLinkClickContext value={surface.onLinkClick}>
        <NativeChatSessionHistoryScopeContext.Provider value={surface.sessionHistory}>
          <NativeChatFindQueryContext value={surface.find.isOpen ? surface.find.query : ''}>
            {children}
          </NativeChatFindQueryContext>
        </NativeChatSessionHistoryScopeContext.Provider>
      </NativeChatLinkClickContext>

      {surface.menu}
      <LinkActionPopover request={surface.linkActionRequest} onClose={surface.closeLinkActions} />
      <NativeChatVideoNotesHost root={surface.rootRef} />
    </div>
  )
}

/** The surface's Find bar, placed by each screen over its transcript. */
export function NativeChatSurfaceFindBar({
  surface,
  isVisible
}: {
  surface: NativeChatSurfaceState
  isVisible: boolean
}): React.JSX.Element | null {
  return surface.find.isOpen ? (
    <NativeChatFindBar find={surface.find} isVisible={isVisible} />
  ) : null
}
