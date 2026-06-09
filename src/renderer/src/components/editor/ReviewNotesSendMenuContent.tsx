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
import { translate } from '@/i18n/i18n'

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
  const canSendToActiveAgent = useCanSendNotesToActiveTerminal(worktreeId)

  const sendToActiveAgent = useCallback(() => {
    if (!hasPrompt || !canSendToActiveAgent) {
      return
    }
    const pending = toast.loading(translate("auto.components.editor.ReviewNotesSendMenuContent.50f7e753ea", "Sending notes to active agent..."))
    void sendNotesToActiveAgentSession({ worktreeId, prompt })
      .then((result) => {
        if (result.status === 'sent') {
          onPromptDelivered?.()
          toast.success(translate("auto.components.editor.ReviewNotesSendMenuContent.bb9c69a0c9", "Notes sent to active agent."))
          return
        }
        toast.message(activeAgentNotesSendFailureMessage(result.status))
      })
      .catch((error) => {
        console.error('Failed to send notes to active agent:', error)
        toast.error(translate("auto.components.editor.ReviewNotesSendMenuContent.f5096c6e4e", "Could not send notes to the active agent."))
      })
      .finally(() => {
        toast.dismiss(pending)
      })
  }, [canSendToActiveAgent, hasPrompt, worktreeId, prompt, onPromptDelivered])

  return (
    <>
      <DropdownMenuLabel>{translate("auto.components.editor.ReviewNotesSendMenuContent.03378aea75", "Send notes to")}</DropdownMenuLabel>
      <DropdownMenuItem
        disabled={!hasPrompt || !canSendToActiveAgent}
        onSelect={sendToActiveAgent}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <SquareTerminal className="size-3.5" />
        {translate("auto.components.editor.ReviewNotesSendMenuContent.e84705f223", "Active agent session")}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{translate("auto.components.editor.ReviewNotesSendMenuContent.a49800405b", "New agent")}</DropdownMenuLabel>
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
