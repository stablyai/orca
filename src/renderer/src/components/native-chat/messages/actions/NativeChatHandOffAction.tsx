import { MessageSquarePlus } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'
import type { NativeChatHandOffRowAction } from './native-chat-hand-off-context'

export function NativeChatHandOffAction({
  messageId,
  handOff
}: {
  messageId: string
  handOff: NativeChatHandOffRowAction
}): React.JSX.Element {
  const t = useTranslate()
  const label = t('components.native-chat.handOff.action', 'Hand off from this response')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label}
          onClick={() => handOff.openFromResponse(messageId)}
        >
          <MessageSquarePlus className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {t(
          'components.native-chat.handOff.tooltip',
          'Hand off from this response. Starts a new session with this chat up to this response.'
        )}
      </TooltipContent>
    </Tooltip>
  )
}
