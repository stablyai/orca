import { useMemo } from 'react'
import { MessageSquare, SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { isMacPlatform, nativeChatToggleShortcutLabel } from './native-chat-shortcut'

/** Tab-level control to flip an agent terminal between the raw terminal and the
 *  native chat view. A ghost icon button matching the pane split/close controls
 *  (TerminalPaneHeaderOverlay), kept as a top-right overlay so it does not
 *  disturb the live xterm layout beneath it. Tab-level — native chat replaces the
 *  whole tab view, so it is not duplicated per split pane. */
export function NativeChatToggleButton({
  isChatViewMode,
  onToggle
}: {
  isChatViewMode: boolean
  onToggle: () => void
}): React.JSX.Element {
  const shortcutLabel = useMemo(() => nativeChatToggleShortcutLabel(isMacPlatform()), [])
  const label = isChatViewMode
    ? translate('components.native-chat.toggle.showTerminal', 'Show terminal')
    : translate('components.native-chat.toggle.showChat', 'Show chat view')
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            aria-pressed={isChatViewMode}
            // Match the pane split/close overlay buttons: a subtle ghost icon that
            // reads as terminal chrome, with a faint surface so it stays legible
            // over arbitrary xterm content.
            className="native-chat-toggle-trigger absolute right-1.5 top-1.5 z-20 bg-card/80 text-muted-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-accent-foreground"
            onPointerDown={(event) => {
              // Why: stop the overlay's group-focus pointer handler from also
              // firing, and prevent the click from stealing terminal focus.
              event.stopPropagation()
            }}
            onClick={(event) => {
              event.stopPropagation()
              onToggle()
            }}
          >
            {isChatViewMode ? (
              <SquareTerminal className="size-3" />
            ) : (
              <MessageSquare className="size-3" />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {label} ({shortcutLabel})
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
