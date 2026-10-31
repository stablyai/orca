import type { AiVaultOriginalPaneTarget } from './ai-vault-original-pane'
import { useConversationSwitchReadiness } from '@/lib/conversation-surface-switch'
import { historyConversationSwitch } from './ai-vault-session-in-place-switch'
import type { AiVaultSession, AiVaultAgent } from '../../../../shared/ai-vault-types'
import { MessagesSquare, SquareTerminal } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
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
  session,
  originalPaneTarget,
  switchExplanation,
  switchLoading = false,
  switchesInPlace = inPlaceAgent !== undefined
}: {
  session?: AiVaultSession
  originalPaneTarget?: AiVaultOriginalPaneTarget | null
  switchExplanation?: string
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
  /** Whether a switch replaces in place; otherwise it opens beside the source, as main's Continue did. */
  switchesInPlace?: boolean
}): React.JSX.Element {
  const chat = useConversationSwitchReadiness(
    session ? historyConversationSwitch(session, 'chat', undefined, originalPaneTarget) : null
  )
  const cli = useConversationSwitchReadiness(
    session ? historyConversationSwitch(session, 'terminal', undefined, originalPaneTarget) : null
  )
  const heldChat = session && inPlaceAgent ? chat : null
  const heldCli = session?.structuredSession && inPlaceAgent ? cli : null
  const inPlace = switchesInPlace
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  return (
    <>
      {onResumeInNewChat ? (
        <Item
          onSelect={onResumeInNewChat}
          disabled={chatPending || switchLoading || Boolean(heldChat && !heldChat.ready)}
          title={switchExplanation ?? heldChat?.explanation}
          aria-busy={chatPending || undefined}
        >
          <MessagesSquare className="size-3.5" />
          {inPlace
            ? translate('components.tab.bar.switch.toNativeChat', 'Switch to Chat UI')
            : action === 'resume'
              ? translate(
                  'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
                  'Resume in New Chat'
                )
              : translate(
                  'components.tab.bar.SortableTabContextMenu.continueInChatView',
                  'Continue in Chat UI'
                )}
        </Item>
      ) : null}
      {onResumeInNewCli ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Item
              onSelect={onResumeInNewCli}
              disabled={cliPending || switchLoading || Boolean(heldCli && !heldCli.ready)}
              title={switchExplanation ?? heldCli?.explanation}
              aria-busy={cliPending}
            >
              {cliPending ? (
                <LoadingSpinner className="size-3.5" />
              ) : (
                <SquareTerminal className="size-3.5" />
              )}
              {inPlace
                ? translate('components.tab.bar.switch.toCli', 'Switch to CLI')
                : action === 'resume'
                  ? translate(
                      'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCli',
                      'Resume in New Terminal'
                    )
                  : translate(
                      'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
                      'Continue with Terminal Agent'
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
