import { useEffect, useRef, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { RightSidebarVisualState } from '@/store/slices/editor/actions/right-sidebar-state'
import { findNativeChatTabOwnerWorktreeId } from './native-chat-file-link'
import { NativeChatVisualFrame } from './NativeChatVisualFrame'
import { NativeChatVisualUnavailable } from './NativeChatInlineVisual'
import { useNativeChatVisualDocument } from './use-native-chat-visual-document'

/**
 * A chat visual opened in the right sidebar: the same isolated frame as inline, filling the panel.
 * It belongs to its chat and workspace, so it closes when the chat tab goes away or the user moves
 * to another workspace.
 */
export default function NativeChatVisualPanel({
  route
}: {
  route: RightSidebarVisualState
}): React.JSX.Element {
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [retired, setRetired] = useState(false)
  const closeRightSidebarVisual = useAppStore((state) => state.closeRightSidebarVisual)
  const ownerPresent = useAppStore(
    (state) =>
      state.activeWorktreeId === route.worktreeId &&
      findNativeChatTabOwnerWorktreeId(state, route.tabId) === route.worktreeId
  )
  const state = useNativeChatVisualDocument(
    { target: route.target, sessionId: route.sessionId, file: route.file },
    ownerPresent
  )

  useEffect(() => {
    if (!ownerPresent) {
      closeRightSidebarVisual()
    }
  }, [closeRightSidebarVisual, ownerPresent])

  const label = route.title ?? route.file
  const closeLabel = translate('components.native-chat.visualClose', 'Close visualization')

  return (
    <div ref={panelRef} className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 min-h-9 items-center justify-between gap-2 border-b border-border pr-1 pl-3">
        <span className="min-w-0 truncate text-[13px] text-foreground">{label}</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={closeLabel}
              onClick={closeRightSidebarVisual}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {closeLabel}
          </TooltipContent>
        </Tooltip>
      </div>
      {retired || state.status === 'unavailable' ? (
        <div className="px-3">
          <NativeChatVisualUnavailable />
        </div>
      ) : state.status === 'ready' ? (
        <NativeChatVisualFrame
          document={state.document}
          title={label}
          layout="panel"
          themeScope={panelRef}
          onRetired={() => setRetired(true)}
        />
      ) : null}
    </div>
  )
}
