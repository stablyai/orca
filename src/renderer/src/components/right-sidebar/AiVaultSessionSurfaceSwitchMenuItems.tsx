import { MessagesSquare, SquareTerminal } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { ContextMenuItem } from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { ResumeInNewCliTooltipText } from './ai-vault-session-cli-fork-copy'

/** "Resume in New Native Chat" / "Resume in New CLI", shared by the session-history row menus and
 *  the tab menu so both offer the same move under the same words. */
export function AiVaultSessionSurfaceSwitchMenuItems({
  menuKind,
  tooltipSide,
  onResumeInNewChat,
  onResumeInNewCli
}: {
  menuKind: 'dropdown' | 'context'
  tooltipSide: 'left' | 'right'
  onResumeInNewChat?: () => void
  onResumeInNewCli?: () => void
}): React.JSX.Element {
  const Item = menuKind === 'context' ? ContextMenuItem : DropdownMenuItem
  return (
    <>
      {onResumeInNewChat ? (
        <Item onSelect={onResumeInNewChat}>
          <MessagesSquare className="size-3.5" />
          {translate(
            'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
            'Resume in New Native Chat'
          )}
        </Item>
      ) : null}
      {onResumeInNewCli ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Item onSelect={onResumeInNewCli}>
              <SquareTerminal className="size-3.5" />
              {translate(
                'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewCli',
                'Resume in New CLI'
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
