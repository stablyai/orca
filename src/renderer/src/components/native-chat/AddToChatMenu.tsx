import { useSyncExternalStore } from 'react'
import { Quote } from 'lucide-react'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
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
import type { LaunchSource } from '../../../../shared/telemetry-property-schemas'

type AddToChatSource = { worktreeId: string; quote: string; launchSource: LaunchSource }

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
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Quote />
        {translate('components.native-chat.addSelectionToChat', 'Add to chat')}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[220px]">
        <AddToChatTargets {...props} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

type PointMenu = AddToChatSource & { x: number; y: number }

let pointMenu: PointMenu | null = null
const listeners = new Set<() => void>()

function setPointMenu(next: PointMenu | null): void {
  pointMenu = next
  listeners.forEach((listener) => listener())
}

function subscribePointMenu(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Opens the target list at a screen point, for surfaces with no menu of their own to nest it in. */
export function openAddToChatMenuAt(menu: PointMenu): void {
  setPointMenu(menu)
}

export function AddToChatPointMenuHost(): React.JSX.Element | null {
  const menu = useSyncExternalStore(subscribePointMenu, () => pointMenu)
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
      >
        <AddToChatTargets {...menu} />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
