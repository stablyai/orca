import { GitBranch, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import type { NativeChatForkSurface } from './native-chat-fork-context'

export function NativeChatForkAction({
  itemId,
  fork
}: {
  itemId: string
  fork: NativeChatForkSurface
}) {
  const label = fork.pending
    ? translate('components.native-chat.fork.pending', 'Creating branch…')
    : translate('components.native-chat.fork.action', 'Branch in new chat')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          disabled={fork.pending}
          aria-label={label}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          onClick={() => void fork.request(itemId)}
        >
          {fork.pending ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <GitBranch className="size-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
