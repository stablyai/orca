import {
  useConversationSwitchBusy,
  useConversationSwitchReadiness,
  runCliChatResume
} from '@/lib/conversation-surface-switch'
import { useShallow } from 'zustand/react/shallow'
import { Loader2, MessagesSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  resolveCliChatResumeSource,
  useCliChatResumeCapability
} from '../tab-bar/cli-chat-resume-source'

export function TerminalPaneResumeInChatButton({
  tabId,
  worktreeId,
  paneKey,
  conversationUnknown = false
}: {
  tabId: string
  worktreeId: string
  paneKey: string
  /** The running agent hasn't reported its conversation: a remembered one is never offered. */
  conversationUnknown?: boolean
}): React.JSX.Element | null {
  const resolved = useAppStore(
    useShallow((state) =>
      resolveCliChatResumeSource(state, { tab: { id: tabId, worktreeId }, paneKey })
    )
  )
  const source = conversationUnknown ? null : resolved
  const capability = useCliChatResumeCapability(worktreeId, source?.agent)
  const readiness = useConversationSwitchReadiness(
    source ? { direction: 'chat', ...source, source } : null
  )
  const busy = useConversationSwitchBusy(readiness.pending)

  // An older host or an agent that can't switch opens the chat beside the pane, as main's Continue did.
  const label =
    capability === false
      ? translate(
          'components.tab.bar.SortableTabContextMenu.continueInChatView',
          'Continue in Chat UI'
        )
      : translate('components.tab.bar.switch.toNativeChat', 'Switch to Chat UI')
  const updateRequired = source?.hostUpdateRequired === true
  // Disabled until the agent reports its conversation, or until the host is updated: the span
  // carries the reason to pointer and keyboard users alike.
  const explained = updateRequired || !source
  const tooltip = updateRequired
    ? translate(
        'components.native-chat.resumeInNewChat.hostUpdateRequired',
        'Update Orca on this host to continue in Chat UI.'
      )
    : !source
      ? translate(
          'components.tab.bar.switch.noConversation',
          'No saved conversation is available in this terminal yet.'
        )
      : (readiness.explanation ??
        (capability === false
          ? label
          : translate(
              'components.tab.bar.switch.toNativeChatTooltip',
              'Switch to Chat UI: continues the same conversation in a chat, in this tab.'
            )))

  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so the span carries the tooltip. */}
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={explained ? 0 : undefined}>
          <Button
            type="button"
            variant="pane-title"
            size="icon-xs"
            aria-label={explained ? `${label}. ${tooltip}` : label}
            disabled={!readiness.ready}
            aria-disabled={!readiness.ready || undefined}
            aria-busy={readiness.pending || undefined}
            onClick={(event) => {
              event.stopPropagation()
              if (source && readiness.ready) {
                void runCliChatResume(source)
              }
            }}
          >
            {busy ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <MessagesSquare className="size-3" />
            )}
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
