import { GitFork } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { NativeChatForkRowAction } from './use-native-chat-fork'

export function NativeChatForkAction({
  itemId,
  fork
}: {
  itemId: string
  fork: NativeChatForkRowAction
}) {
  const label = translate('components.native-chat.fork.action', 'Fork from this response')
  // Disabled while support is still being learned; an unoffered row keeps an empty slot of this size.
  const disabledReason = fork.pending
    ? translate('components.native-chat.fork.pending', 'Forking this chat…')
    : fork.support.kind === 'unknown'
      ? translate('components.native-chat.fork.checking', 'Checking whether this chat can fork…')
      : null
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50"
          aria-label={label}
          aria-description={disabledReason ?? undefined}
          aria-disabled={disabledReason !== null}
          onClick={() => {
            if (disabledReason === null) {
              fork.request(itemId)
            }
          }}
        >
          <GitFork className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {disabledReason ??
          translate(
            'components.native-chat.fork.tooltip',
            'Fork from this response. The new chat includes this whole response, up to the end of its turn.'
          )}
      </TooltipContent>
    </Tooltip>
  )
}
