import { useShallow } from 'zustand/react/shallow'
import { MessagesSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { resolveCliChatResumeSource } from '../../tab-bar/cli-chat-resume-source'
import { runCliChatResume, useCliChatResumePending } from '../../tab-bar/cli-chat-resume-run'

export function TerminalPaneResumeInChatButton({
  tabId,
  worktreeId,
  paneKey
}: {
  tabId: string
  worktreeId: string
  paneKey: string
}): React.JSX.Element {
  const t = useTranslate()
  const source = useAppStore(
    useShallow((state) =>
      resolveCliChatResumeSource(state, {
        tab: { id: tabId, worktreeId },
        paneKey
      })
    )
  )
  const pending = useCliChatResumePending(source)
  const updateRequired = source?.hostUpdateRequired === true
  const label = t(
    'components.tab.bar.SortableTabContextMenu.switchToChatView',
    'Continue in Chat UI'
  )
  const tooltip = updateRequired
    ? t(
        'components.native-chat.resumeInNewChat.hostUpdateRequired',
        'Update Orca on this host to continue in Chat UI.'
      )
    : label

  return (
    <Tooltip>
      {/* A disabled button gets no pointer events, so the span carries the update tooltip. */}
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={updateRequired ? 0 : undefined}>
          <Button
            type="button"
            variant="pane-title"
            size="icon-xs"
            // A disabled button's tooltip is unreachable by screen readers, so the label carries the reason.
            aria-label={updateRequired ? `${label}. ${tooltip}` : label}
            disabled={!source || pending || updateRequired}
            aria-busy={pending || undefined}
            onClick={(event) => {
              event.stopPropagation()
              if (source) {
                void runCliChatResume(source, true)
              }
            }}
          >
            <MessagesSquare className="size-3" />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}
