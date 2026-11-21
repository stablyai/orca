// Keep mounted for fading; hidden state is inert and excluded from assistive technology.
// No rim: a raised fill and the shadow separate the pill; the transparent border keeps a forced-colors edge.
// The label leans past its token (no stronger one exists) so a dim Match Terminal palette still reads 4.5:1.

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
      className="absolute bottom-3 left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-transparent bg-[color-mix(in_srgb,var(--secondary-foreground)_5%,var(--secondary))] px-3 text-xs font-medium text-[color-mix(in_srgb,var(--secondary-foreground)_75%,black)] shadow-floating transition-[opacity,translate,background-color,color] duration-150 ease-out hover:bg-[color-mix(in_srgb,var(--secondary-foreground)_10%,var(--secondary))] dark:bg-accent dark:text-[color-mix(in_srgb,var(--accent-foreground)_75%,white)] dark:hover:bg-[color-mix(in_srgb,var(--accent-foreground)_8%,var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none data-[shown=false]:pointer-events-none data-[shown=false]:translate-y-1 data-[shown=false]:opacity-0"
    >
      <ArrowDown className="size-3.5" />
      <span>{label ?? t('components.native-chat.jumpToLatest', 'Jump to latest')}</span>
    </button>
  )
}
