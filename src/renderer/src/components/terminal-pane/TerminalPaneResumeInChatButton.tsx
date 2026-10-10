import { useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { newAgentLaunchRequestId } from '@/lib/agent-launch-request-id'
import { activateAiVaultStructuredSession } from '@/lib/activate-ai-vault-structured-session'
import { useAppStore } from '@/store'
import { isAiVaultSessionResumableContent } from '../../../../shared/ai-vault-types'
import { agentLabel } from '../../../../shared/ai-vault-session-filters'
import { isAgentSessionHandleProvider } from '../../../../shared/agent-session-provider-handle'
import { resumeAiVaultSessionInNewChat } from '../right-sidebar/ai-vault-session-resume-in-chat-launch'
import {
  lookupTabSessionHistoryRow,
  resolveTabSessionHistorySubject,
  resolveTabSessionSwitch
} from '../tab-bar/tab-session-history-switch'

function notifyResumeFailed(): void {
  toast.error(
    translate(
      'auto.components.right.sidebar.AiVaultPanel.resumeInChatFailed',
      'Could not resume this session in a new chat.'
    )
  )
}

/** The tab menu's "Resume in New Native Chat" for this pane's own conversation. The history lookup
 *  runs on click, not per render, so a header that stays on screen never scans in the background. */
export function TerminalPaneResumeInChatButton({
  tabId,
  worktreeId,
  paneKey
}: {
  tabId: string
  worktreeId: string
  paneKey: string
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const label = translate(
    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
    'Resume in New Native Chat'
  )

  const resume = async (): Promise<void> => {
    const tabIsOpen = (): boolean =>
      useAppStore.getState().tabsByWorktree[worktreeId]?.some((tab) => tab.id === tabId) ?? false
    const subject = resolveTabSessionHistorySubject(useAppStore.getState(), {
      tab: { id: tabId, worktreeId },
      paneKey
    })
    if (subject?.kind !== 'cli') {
      notifyResumeFailed()
      return
    }
    const row = await lookupTabSessionHistoryRow(
      subject,
      (args) => window.api.aiVault.listSessions(args),
      { requestToken: createBrowserUuid(), isCancelled: () => !tabIsOpen(), userRequested: true }
    )
    // Closing the tab mid-lookup abandons the click rather than opening a chat for it.
    if (!tabIsOpen()) {
      return
    }
    if (row === undefined) {
      notifyResumeFailed()
      return
    }
    // Already resumed in a chat: open that chat, as the Session History row's Resume does.
    if (row?.structuredSession) {
      await activateAiVaultStructuredSession(row)
      return
    }
    const agent = agentLabel(subject.agent)
    if (!row || !isAiVaultSessionResumableContent(row)) {
      toast.error(
        translate(
          'components.native-chat.resumeInNewChat.notSavedYet',
          "{{agent}} hasn't saved this conversation yet. Try again after it replies.",
          { agent }
        )
      )
      return
    }
    const move = resolveTabSessionSwitch(useAppStore.getState(), row, subject)
    if (move?.action === 'resume-in-new-chat' && isAgentSessionHandleProvider(row.agent)) {
      await resumeAiVaultSessionInNewChat(
        row,
        row.agent,
        move.worktreeId,
        newAgentLaunchRequestId()
      )
      return
    }
    toast.error(
      translate(
        'components.native-chat.resumeInNewChat.cannotResume',
        "This {{agent}} conversation can't be resumed in a native chat.",
        { agent }
      )
    )
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          // Same class as split so it shares the hover/active reveal.
          className="pane-title-split-trigger"
          aria-label={label}
          disabled={pending}
          onClick={(event) => {
            event.stopPropagation()
            setPending(true)
            void resume()
              .catch(notifyResumeFailed)
              .finally(() => setPending(false))
          }}
        >
          <MessagesSquare className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
