import { useState } from 'react'
import { MessagesSquare } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { useAppStore } from '@/store'
import { resolveTabSessionHistorySubject } from '../tab-bar/tab-session-history-switch'
import {
  lookupTabSessionSwitch,
  useTabSessionLaunchActions
} from '../tab-bar/tab-session-switch-actions'

function notifyResumeUnavailable(): void {
  toast.error(
    translate(
      'components.native-chat.resumeInNewChat.unavailable',
      "This session can't be resumed in a native chat yet. Try again after the agent replies."
    )
  )
}

/** The tab menu's "Resume in New Native Chat" in the pane header. The history lookup runs on click,
 *  not per render, so a header that stays on screen never scans in the background. */
export function TerminalPaneResumeInChatButton({
  tabId,
  worktreeId
}: {
  tabId: string
  worktreeId: string
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const launchActions = useTabSessionLaunchActions(worktreeId)
  const label = translate(
    'auto.components.right.sidebar.AiVaultSessionRow.resumeInNewNativeChat',
    'Resume in New Native Chat'
  )

  const resume = async (): Promise<void> => {
    const subject = resolveTabSessionHistorySubject(useAppStore.getState(), {
      tab: { id: tabId, worktreeId }
    })
    const resolved = subject
      ? await lookupTabSessionSwitch(
          subject,
          () => useAppStore.getState(),
          (args) => window.api.aiVault.listSessions(args),
          { requestToken: createBrowserUuid(), isCancelled: () => false }
        )
      : null
    if (resolved?.move.action === 'resume-in-new-chat') {
      launchActions.handleResumeInNewChat(resolved.session, resolved.move.worktreeId)
      return
    }
    notifyResumeUnavailable()
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
              .catch(notifyResumeUnavailable)
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
