import { useShallow } from 'zustand/react/shallow'
import { MessagesSquare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { resolveCliChatResumeSource } from '../tab-bar/cli-chat-resume-source'
import { runCliChatResume, useCliChatResumePending } from '../tab-bar/cli-chat-resume-run'

export function TerminalPaneResumeInChatButton({
  tabId,
  worktreeId,
  paneKey
}: {
  tabId: string
  worktreeId: string
  paneKey: string
}): React.JSX.Element {
  const source = useAppStore(
    useShallow((state) =>
      resolveCliChatResumeSource(state, {
        tab: { id: tabId, worktreeId },
        paneKey
      })
    )
  )
  const pending = useCliChatResumePending(source)
  const label = translate(
    'components.tab.bar.SortableTabContextMenu.switchToChatView',
    'Continue in Chat UI'
  )

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="pane-title"
          size="icon-xs"
          aria-label={label}
          disabled={!source || pending}
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
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
