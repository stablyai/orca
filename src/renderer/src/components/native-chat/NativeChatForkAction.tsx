import { GitFork } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'

export function NativeChatForkAction({ onFork }: { onFork: () => void }) {
  const label = translate('components.native-chat.fork.action', 'Fork from this turn')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* Styled like the copy button beside it in the same hover strip. */}
        <button
          type="button"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-chat-foreground-faint transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={label}
          onClick={onFork}
        >
          <GitFork className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
