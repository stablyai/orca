import { SquareTerminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatTabSession } from '../../../tab-bar/tab-session-history-switch'
import { useNativeChatCliHandoff } from './use-native-chat-cli-handoff'

export function NativeChatResumeInCliButton(props: {
  tabId: string
  worktreeId: string
  nativeChat: NativeChatTabSession
}): React.JSX.Element | null {
  const t = useTranslate()
  const handoff = useNativeChatCliHandoff(props)
  const label = t(
    'components.tab.bar.SortableTabContextMenu.switchToTerminalView',
    'Continue with Terminal Agent'
  )
  if (!handoff) {
    return null
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="pane-title"
          size="icon-xs"
          aria-label={label}
          disabled={handoff.pending}
          aria-busy={handoff.pending || undefined}
          onClick={(event) => {
            event.stopPropagation()
            handoff.run()
          }}
        >
          <SquareTerminal className="size-3" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
