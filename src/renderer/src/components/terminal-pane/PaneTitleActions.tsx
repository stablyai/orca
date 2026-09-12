import {
  MessageSquare,
  MessageSquarePlus,
  SquareSplitVertical,
  SquareTerminal,
  X
} from 'lucide-react'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

type PaneTitleActionsProps = {
  pane: ManagedPane
  title: string
  isActivePane: boolean
  paneCount: number
  showAlwaysOnHeaders: boolean
  showSplitButton: boolean
  splitRightLabel: string
  canContinueAgentSessionInNewSession?: boolean
  onContinueAgentSessionInNewSession?: (pane: ManagedPane) => void
  canToggleNativeChat?: boolean
  isChatViewMode?: boolean
  onToggleNativeChat?: () => void
  onSplitPane: (pane: ManagedPane, direction: 'vertical' | 'horizontal') => void
  onRemoveTitle: (paneId: number) => void
  onClosePane: (paneId: number) => void
}

/** The [continue-in-new-session][chat][split][×] button cluster at the end of a
 *  pane's title bar. Every button stops propagation on both pointerdown (so it
 *  doesn't also start the bar's pane-drag) and dblclick (a native dblclick is a
 *  separate event the click handler's stopPropagation doesn't touch, and would
 *  otherwise bubble up into the bar's rename handler). */
export default function PaneTitleActions({
  pane,
  title,
  isActivePane,
  paneCount,
  showAlwaysOnHeaders,
  showSplitButton,
  splitRightLabel,
  canContinueAgentSessionInNewSession,
  onContinueAgentSessionInNewSession,
  canToggleNativeChat,
  isChatViewMode,
  onToggleNativeChat,
  onSplitPane,
  onRemoveTitle,
  onClosePane
}: PaneTitleActionsProps): React.JSX.Element {
  return (
    <div className="pane-title-actions ml-auto flex shrink-0 items-center gap-0">
      {canContinueAgentSessionInNewSession && isActivePane ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="pane-title-split-trigger"
              aria-label={translate(
                'components.agentSessionContinuation.continueInNewSession',
                'Continue in New Session…'
              )}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onContinueAgentSessionInNewSession?.(pane)
              }}
            >
              <MessageSquarePlus className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate(
              'components.agentSessionContinuation.continueInNewSession',
              'Continue in New Session…'
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {canToggleNativeChat && isActivePane ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              // Same class as split so it shares the hover/active reveal
              // and sits as a peer in the [chat][split][×] cluster.
              className="pane-title-split-trigger"
              aria-label={
                isChatViewMode
                  ? translate('components.native-chat.toggle.showTerminal', 'Show terminal')
                  : translate('components.native-chat.toggle.showChat', 'Show chat view')
              }
              aria-pressed={isChatViewMode}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onToggleNativeChat?.()
              }}
            >
              {isChatViewMode ? (
                <SquareTerminal className="size-3" />
              ) : (
                <MessageSquare className="size-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {isChatViewMode
              ? translate('components.native-chat.toggle.showTerminal', 'Show terminal')
              : translate('components.native-chat.toggle.showChat', 'Show chat view')}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {showAlwaysOnHeaders && showSplitButton ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="pane-title-split-trigger"
              data-contextual-tour-target={isActivePane ? 'terminal-pane-split-target' : undefined}
              aria-label={splitRightLabel}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onSplitPane(pane, 'vertical')
              }}
            >
              <SquareSplitVertical className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {splitRightLabel}
          </TooltipContent>
        </Tooltip>
      ) : null}
      {title ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="pane-title-close"
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onRemoveTitle(pane.id)
              }}
              aria-label={translate(
                'auto.components.terminal.pane.TerminalPane.f984ab2a30',
                'Remove pane title: {{value0}}',
                { value0: title }
              )}
            >
              <X className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate('auto.components.terminal.pane.TerminalPane.ac112e9036', 'Remove title')}
          </TooltipContent>
        </Tooltip>
      ) : paneCount > 1 && showAlwaysOnHeaders ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="pane-title-close"
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation()
                onClosePane(pane.id)
              }}
              aria-label={translate(
                'auto.components.terminal.pane.TerminalContextMenu.8c17d6786d',
                'Close Pane'
              )}
            >
              <X className="size-3" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={4}>
            {translate(
              'auto.components.terminal.pane.TerminalContextMenu.8c17d6786d',
              'Close Pane'
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </div>
  )
}
