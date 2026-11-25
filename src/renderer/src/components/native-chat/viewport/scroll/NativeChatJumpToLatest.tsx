// Keep mounted for fading; hidden state is inert and excluded from assistive technology.
// Icon-only glass circle: a translucent blurred panel fill and the composer's hairline keep it light over busy text.
// Over a worker pill or its open card it rides 8px above them (--native-chat-worker-jump-lift);
// in a pane too short for both it steps aside while the card is open.

import { ArrowDown } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslate } from '@/i18n/use-translate'

/** Keeps focus where the reader was typing: a pointer press never moves it here. */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault()
}

export function NativeChatJumpToLatest({
  visible,
  onJump,
  label
}: {
  visible: boolean
  onJump: () => void
  /** Jump to latest by default; names the button and its tooltip. */
  label?: string
}): React.JSX.Element {
  const t = useTranslate()
  const name = label ?? t('components.native-chat.jumpToLatest', 'Jump to latest')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={name}
          data-shown={visible}
          data-native-chat-jump-latest=""
          inert={!visible}
          aria-hidden={!visible || undefined}
          onMouseDown={keepFocus}
          onClick={onJump}
          className="absolute bottom-[max(calc(var(--spacing)*3),var(--native-chat-worker-jump-lift,0px))] left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-chat-composer-border bg-popover/80 text-popover-foreground shadow-sm backdrop-blur-md transition-[opacity,translate,background-color] duration-150 ease-out hover:bg-popover/95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none [[data-worker-dock-cramped]_&]:invisible data-[shown=false]:pointer-events-none data-[shown=false]:translate-y-1 data-[shown=false]:opacity-0"
        >
          <ArrowDown className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {name}
      </TooltipContent>
    </Tooltip>
  )
}
