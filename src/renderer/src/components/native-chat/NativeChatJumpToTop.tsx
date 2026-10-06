// The way to the start of the conversation, offered beside "Jump to latest".
//
// Mounted and inert while hidden, like "Jump to latest", so it fades rather than pops.

import { ArrowUp, Loader2 } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { keepFocus } from './NativeChatJumpToLatest'
import type { useNativeChatRailHistoryJump } from './use-native-chat-rail-history-jump'

export function NativeChatJumpToTop({
  visible,
  historyJump
}: {
  visible: boolean
  historyJump: Pick<
    ReturnType<typeof useNativeChatRailHistoryJump>,
    'startPending' | 'startFromBeginning'
  >
}): React.JSX.Element {
  const pending = historyJump.startPending
  const label = translate('components.native-chat.jumpToTop', 'Jump to top')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-busy={pending || undefined}
          data-shown={visible}
          inert={!visible}
          aria-hidden={!visible || undefined}
          onMouseDown={keepFocus}
          onClick={historyJump.startFromBeginning}
          className="pointer-events-auto flex size-8 items-center justify-center rounded-full border border-border bg-popover text-popover-foreground shadow-floating transition-[opacity,translate] duration-150 ease-out hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none data-[shown=false]:pointer-events-none data-[shown=false]:translate-y-1 data-[shown=false]:opacity-0"
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" />
          ) : (
            <ArrowUp className="size-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
