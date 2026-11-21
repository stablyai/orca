// Keep mounted for fading; hidden state is inert and excluded from assistive technology.
// Why no rim: a raised fill (secondary on the dark canvas) and the shadow separate the pill from text behind it.

import { ArrowDown } from 'lucide-react'
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
  /** Jump to latest by default. */
  label?: string
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <button
      type="button"
      data-shown={visible}
      inert={!visible}
      aria-hidden={!visible || undefined}
      onMouseDown={keepFocus}
      onClick={onJump}
      className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full bg-popover px-3 text-xs font-medium text-popover-foreground shadow-floating transition-[opacity,translate,background-color] duration-150 ease-out hover:bg-accent hover:text-accent-foreground dark:bg-secondary dark:hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none data-[shown=false]:pointer-events-none data-[shown=false]:translate-y-1 data-[shown=false]:opacity-0"
    >
      <ArrowDown className="size-3.5" />
      <span>{label ?? t('components.native-chat.jumpToLatest', 'Jump to latest')}</span>
    </button>
  )
}
