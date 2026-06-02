import React, { useCallback } from 'react'
import { SquareTerminal } from 'lucide-react'
import { toast } from 'sonner'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import {
  activeAgentNotesSendFailureMessage,
  sendNotesToActiveAgentSession,
  useCanSendNotesToActiveTerminal
} from '@/lib/active-agent-note-send'
import type { LaunchSource } from '../../../../shared/telemetry-events'

export function ReviewNotesSendMenuContent({
  worktreeId,
  groupId,
  prompt,
  promptDelivery = 'submit-after-ready',
  launchSource = 'notes_send',
  onPromptDelivered
}: {
  worktreeId: string
  groupId: string
  prompt: string
  promptDelivery?: 'auto-submit' | 'draft' | 'submit-after-ready'
  launchSource?: LaunchSource
  onPromptDelivered?: () => void
}): React.JSX.Element {
  const hasPrompt = prompt.trim().length > 0
  const canSendToActiveTerminal = useCanSendNotesToActiveTerminal(worktreeId)

  const sendToActiveAgent = useCallback(() => {
    const pending = toast.loading('Sending notes to active agent...')
    void sendNotesToActiveAgentSession({ worktreeId, prompt })
      .then((result) => {
        if (result.status === 'sent') {
          onPromptDelivered?.()
          toast.success('Notes sent to active agent.')
          return
        }
        toast.message(activeAgentNotesSendFailureMessage(result.status))
      })
      .catch((error) => {
        console.error('Failed to send notes to active agent:', error)
        toast.error('Could not send notes to the active agent.')
      })
      .finally(() => {
        toast.dismiss(pending)
      })
  }, [worktreeId, prompt, onPromptDelivered])

  return (
    <>
      <DropdownMenuLabel>Send notes to</DropdownMenuLabel>
      <DropdownMenuItem
        disabled={!hasPrompt || !canSendToActiveTerminal}
        onSelect={sendToActiveAgent}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <SquareTerminal className="size-3.5" />
        Active agent session
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>New agent</DropdownMenuLabel>
      <QuickLaunchAgentMenuItems
        worktreeId={worktreeId}
        groupId={groupId}
        onFocusTerminal={focusTerminalTabSurface}
        prompt={prompt}
        promptDelivery={promptDelivery}
        launchSource={launchSource}
        onPromptDelivered={onPromptDelivered}
      />
    </>
  )
}
