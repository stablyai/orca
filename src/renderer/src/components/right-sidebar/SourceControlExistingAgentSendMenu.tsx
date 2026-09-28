import React from 'react'
import { ChevronDown, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { ExistingAgentSendMenuItems } from '@/components/editor/ReviewNotesSendMenuContent'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import { translate } from '@/i18n/i18n'

export type SourceControlExistingAgentSendMenuProps = {
  worktreeId: string
  prompt: string
  launchSource: LaunchSource
  disabled: boolean
  onSendStarted: () => void
  onPromptDelivered: () => void
  onSendFailed: () => void
}

/** Alternative to starting a new agent: deliver the rendered prompt into a running session. */
export function SourceControlExistingAgentSendMenu({
  worktreeId,
  prompt,
  launchSource,
  disabled,
  onSendStarted,
  onPromptDelivered,
  onSendFailed
}: SourceControlExistingAgentSendMenuProps): React.JSX.Element {
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" disabled={disabled}>
          <Send className="size-4" />
          {translate(
            'auto.components.right.sidebar.SourceControlExistingAgentSendMenu.trigger',
            'Send to running agent'
          )}
          <ChevronDown className="size-3.5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>
          {translate(
            'auto.components.right.sidebar.SourceControlExistingAgentSendMenu.label',
            'Send prompt to'
          )}
        </DropdownMenuLabel>
        <ExistingAgentSendMenuItems
          worktreeId={worktreeId}
          prompt={prompt}
          launchSource={launchSource}
          toastCopy={{
            sending: translate(
              'auto.components.right.sidebar.SourceControlExistingAgentSendMenu.sending',
              'Sending prompt...'
            ),
            sent: translate(
              'auto.components.right.sidebar.SourceControlExistingAgentSendMenu.sent',
              'Prompt sent.'
            )
          }}
          emptyLabel={translate(
            'auto.components.right.sidebar.SourceControlExistingAgentSendMenu.empty',
            'No running agents in this workspace'
          )}
          onSendStarted={onSendStarted}
          onPromptDelivered={onPromptDelivered}
          onSendFailed={onSendFailed}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
