import { MessagesSquare, SquareTerminal } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { ResumeInNewCliTooltipText } from './ai-vault-session-cli-fork-copy'

/** History opens a new tab; active-tab controls switch surfaces. */
export function AiVaultSessionSurfaceSwitchMenuItems({
  action,
  menuKind,
  tooltipSide,
  chatPending,
  onResumeInNewChat,
  onResumeInNewCli,
  cliPending = false
}: {
  action: 'resume' | 'switch'
  menuKind: 'dropdown' | 'context'
  tooltipSide: 'left' | 'right'
  chatPending?: boolean
  onResumeInNewChat?: (event: Event) => void
  onResumeInNewCli?: (event: Event) => void
  cliPending?: boolean
}): React.JSX.Element {
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  return (
    <>
      {onResumeInNewChat ? (
        <Item
          onSelect={onResumeInNewChat}
          disabled={chatPending}
          aria-busy={chatPending || undefined}
        >
          <MessagesSquare className="size-3.5" />
          {action === 'resume'
            ? translate(
                'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
                'Resume in New Chat'
              )
            : translate(
                'components.tab.bar.SortableTabContextMenu.switchToChatView',
                'Switch to Chat UI'
              )}
        </Item>
      ) : null}
      {onResumeInNewCli ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Item onSelect={onResumeInNewCli} disabled={cliPending} aria-busy={cliPending}>
              {cliPending ? (
                <LoadingSpinner className="size-3.5" />
              ) : (
                <SquareTerminal className="size-3.5" />
              )}
              {action === 'resume'
                ? translate(
                    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCli',
                    'Resume in New Terminal'
                  )
                : translate(
                    'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
                    'Switch to Terminal Agent'
                  )}
            </Item>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide} sideOffset={8}>
            <ResumeInNewCliTooltipText />
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}
