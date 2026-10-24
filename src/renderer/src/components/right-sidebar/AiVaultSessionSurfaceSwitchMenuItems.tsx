import { MessagesSquare, SquareTerminal } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { AiVaultAgent } from '../../../../shared/ai-vault-types'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { ResumeInNewCliTooltipText, SwitchToCliTooltipText } from './ai-vault-session-cli-fork-copy'

/** A tab's terminal always switches in place; History and a chat do once the agent switches in
 *  place on its host (`inPlace`), and otherwise open a new chat or fork into a new terminal. */
export function AiVaultSessionSurfaceSwitchMenuItems({
  action,
  menuKind,
  tooltipSide,
  chatPending,
  onResumeInNewChat,
  onResumeInNewCli,
  cliPending = false,
  inPlaceAgent,
  switchLoading = false
}: {
  action: 'resume' | 'switch'
  menuKind: 'dropdown' | 'context'
  tooltipSide: 'left' | 'right'
  chatPending?: boolean
  onResumeInNewChat?: (event: Event) => void
  onResumeInNewCli?: (event: Event) => void
  cliPending?: boolean
  /** The agent whose conversation switches in place on its host; unset keeps the new-tab entries. */
  switchLoading?: boolean
  inPlaceAgent?: AiVaultAgent
}): React.JSX.Element {
  const inPlace = inPlaceAgent !== undefined
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  return (
    <>
      {onResumeInNewChat ? (
        <Item
          onSelect={onResumeInNewChat}
          disabled={chatPending || switchLoading}
          aria-busy={chatPending || undefined}
        >
          <MessagesSquare className="size-3.5" />
          {action === 'resume' && !inPlace
            ? translate(
                'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
                'Resume in New Chat'
              )
            : translate('components.tab.bar.switch.toNativeChat', 'Switch to native chat')}
        </Item>
      ) : null}
      {onResumeInNewCli ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Item
              onSelect={onResumeInNewCli}
              disabled={cliPending || switchLoading}
              aria-busy={cliPending}
            >
              {cliPending ? (
                <LoadingSpinner className="size-3.5" />
              ) : (
                <SquareTerminal className="size-3.5" />
              )}
              {inPlace
                ? translate('components.tab.bar.switch.toCli', 'Switch to CLI')
                : translate(
                    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCli',
                    'Resume in New Terminal'
                  )}
            </Item>
          </TooltipTrigger>
          <TooltipContent side={tooltipSide} sideOffset={8}>
            {inPlaceAgent ? (
              <SwitchToCliTooltipText agent={inPlaceAgent} />
            ) : (
              <ResumeInNewCliTooltipText />
            )}
          </TooltipContent>
        </Tooltip>
      ) : null}
    </>
  )
}
