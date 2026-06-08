import React, { useCallback, useState } from 'react'
import { SquareArrowOutUpRight } from 'lucide-react'
import { QuickLaunchAgentMenuItems } from '@/components/tab-bar/QuickLaunchButton'
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator
} from '@/components/ui/dropdown-menu'
import { focusTerminalTabSurface } from '@/lib/focus-terminal-tab-surface'
import { sendNotesToMostRecentAgentSession } from '@/lib/most-recent-agent-note-send'
import { cn } from '@/lib/utils'
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
  const [sendingToExistingSession, setSendingToExistingSession] = useState(false)

  const sendToExistingAgentSession = useCallback(() => {
    if (!hasPrompt || sendingToExistingSession) {
      return
    }
    setSendingToExistingSession(true)
    void sendNotesToMostRecentAgentSession({
      worktreeId,
      prompt,
      launchSource,
      onPromptDelivered
    })
      .catch((error) => {
        console.error('Failed to send notes to an existing agent session:', error)
      })
      .finally(() => {
        setSendingToExistingSession(false)
      })
  }, [hasPrompt, launchSource, onPromptDelivered, prompt, sendingToExistingSession, worktreeId])

  return (
    <>
      <DropdownMenuLabel>Send notes to</DropdownMenuLabel>
      <DropdownMenuItem
        disabled={!hasPrompt || sendingToExistingSession}
        onSelect={sendToExistingAgentSession}
        className="gap-2 rounded-[7px] px-2 py-1.5 text-[12px] leading-5 font-medium"
      >
        <SquareArrowOutUpRight
          className={cn('size-3.5', sendingToExistingSession && 'text-violet-500')}
        />
        {sendingToExistingSession ? 'Sending...' : 'Existing agent session'}
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
