import { useSyncExternalStore } from 'react'
import { Quote } from 'lucide-react'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ReviewNotesSendMenuContent } from '@/components/editor/review-note-delivery/ReviewNotesSendMenuContent'
import { preventAgentSendTargetOutsideDismiss } from '@/components/browser-pane/annotate/prevent-agent-send-target-outside-dismiss'
import {
  readPointMenu,
  setPointMenu,
  subscribePointMenu,
  type AddToChatSource
} from './add-to-chat-point-menu'

/** The notes target list, adding the quote unsent to the chat or new agent the user picks. */
function AddToChatTargets({ worktreeId, quote, launchSource }: AddToChatSource): React.JSX.Element {
  // A new agent opens where a new tab from this workspace would.
  const groupId = useAppStore(
    (state) =>
      state.activeGroupIdByWorktree[worktreeId] ?? state.groupsByWorktree[worktreeId]?.[0]?.id ?? ''
  )
  return (
    <ReviewNotesSendMenuContent
      worktreeId={worktreeId}
      groupId={groupId}
      prompt={quote}
      mode="add-to-chat"
      launchSource={launchSource}
    />
  )
}

export function AddToChatSubmenu(props: AddToChatSource): React.JSX.Element {
  const t = useTranslate()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Quote />
        {t('components.native-chat.addSelectionToChat', 'Add to chat')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[220px]">
        <AddToChatTargets {...props} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

export function AddToChatPointMenuHost(): React.JSX.Element | null {
  const menu = useSyncExternalStore(subscribePointMenu, readPointMenu)
  if (!menu) {
    return null
  }
  return (
    <DropdownMenu
      // A new open replaces the old one in place rather than animating between points.
      key={`${menu.x}:${menu.y}:${menu.quote.length}`}
      open
      onOpenChange={(open) => {
        if (!open) {
          setPointMenu(null)
        }
      }}
      modal={false}
    >
      <DropdownMenuTrigger asChild>
        <button
          aria-hidden
          tabIndex={-1}
          className="pointer-events-none fixed size-px opacity-0"
          style={{ left: menu.x, top: menu.y }}
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        sideOffset={4}
        className="min-w-[220px]"
        onInteractOutside={preventAgentSendTargetOutsideDismiss}
        onPointerDownOutside={preventAgentSendTargetOutsideDismiss}
        onEscapeKeyDown={() => {
          menu.cancelled = true
        }}
        onCloseAutoFocus={(event) => {
          // The hidden anchor can't take focus back. A pick hands focus to the chosen agent and an
          // outside click to what was clicked; only Escape returns it to where the selection was.
          event.preventDefault()
          if (menu.cancelled && menu.returnFocus?.isConnected) {
            menu.returnFocus.focus()
          }
        }}
      >
        <AddToChatTargets {...menu} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
