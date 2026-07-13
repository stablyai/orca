import type React from 'react'
import { Play } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { TuiAgent } from '../../../../shared/types'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { translate } from '@/i18n/i18n'
import { resumeWebChatAsLocalAgent } from './ai-vault-web-chat-resume'

// Web resume seeds the default local agent with the imported transcript. Disabled
// when there is no valid default agent or no active workspace to launch into; a
// Radix Tooltip (not `title`, STYLEGUIDE.md) carries the hint so it also surfaces
// on keyboard focus, with the span wrapper keeping hover reachable on a disabled button.
export function AiVaultWebChatResumeButton({
  session,
  resumeAgent,
  activeWorktreeId
}: {
  session: AiVaultSession
  resumeAgent: TuiAgent | null
  activeWorktreeId: string | null
}): React.JSX.Element {
  const disabled = !resumeAgent || !activeWorktreeId
  const hint = !resumeAgent
    ? translate(
        'auto.components.right.sidebar.AiVaultSessionDetails.setDefaultAgentToResume',
        'Set a default agent before resuming.'
      )
    : !activeWorktreeId
      ? translate(
          'auto.components.right.sidebar.AiVaultPanel.openWorkspaceBeforeResuming',
          'Open a workspace before resuming a session.'
        )
      : null

  const button = (
    <Button
      type="button"
      variant="default"
      size="xs"
      disabled={disabled}
      draggable={false}
      onClick={(event) => {
        event.stopPropagation()
        if (resumeAgent && activeWorktreeId) {
          void resumeWebChatAsLocalAgent({
            session,
            agent: resumeAgent,
            worktreeId: activeWorktreeId
          })
        }
      }}
      data-testid="ai-vault-web-chat-resume"
      className="h-7 shrink-0 px-2.5 text-[11px]"
    >
      <Play className="size-3.5" />
      {translate('auto.components.right.sidebar.AiVaultSessionDetails.resumeWebChat', 'Resume')}
    </Button>
  )

  if (disabled && hint) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex" onClick={(event) => event.stopPropagation()}>
            {button}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" sideOffset={4}>
          {hint}
        </TooltipContent>
      </Tooltip>
    )
  }
  return button
}
