import { useConfirmationDialog } from '@/components/confirmation-dialog-context'
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
  paneKey
}: {
  tabId: string
  worktreeId: string
  paneKey: string
}): React.JSX.Element | null {
  const source = useAppStore(
    useShallow((state) =>
      resolveCliChatResumeSource(state, { tab: { id: tabId, worktreeId }, paneKey })
    )
  )
  const capability = useCliChatResumeCapability(worktreeId, source?.agent)
  const confirm = useConfirmationDialog()
  const readiness = useConversationSwitchReadiness(
    source ? { direction: 'chat', ...source, source } : null
  )
  const busy = useConversationSwitchBusy(readiness.pending)

  const label = translate('components.tab.bar.switch.toNativeChat', 'Switch to native chat')
  const updateRequired = source?.hostUpdateRequired === true
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
              'Switch to native chat: continues the same conversation in a chat, in this tab.'
            )))

  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so the span carries the update tooltip. */}
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={updateRequired ? 0 : undefined}>
          <Button
            type="button"
            variant="pane-title"
            size="icon-xs"
            aria-label={updateRequired ? `${label}. ${tooltip}` : label}
            disabled={!readiness.ready}
            aria-disabled={!readiness.ready || undefined}
            aria-busy={readiness.pending || undefined}
            onClick={(event) => {
              event.stopPropagation()
              if (source && readiness.ready) {
                void runCliChatResume(source, confirm)
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
