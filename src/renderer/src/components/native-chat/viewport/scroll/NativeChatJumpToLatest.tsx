// Keep mounted for fading; hidden state is inert and excluded from assistive technology.
// No rim: a raised fill and the shadow separate the pill; the transparent border keeps a forced-colors edge.
// Over a worker pill or its open card it rides 8px above them (--native-chat-worker-jump-lift);
// in a pane too short for both it steps aside while the card is open.
// The label leans past its token (no stronger one exists) so a dim Match Terminal palette still reads 4.5:1.

import { ArrowDown, ArrowUp } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'

/** Keeps focus where the reader was typing: a pointer press never moves it here. */
function keepFocus(event: React.MouseEvent): void {
  event.preventDefault()
}

export function NativeChatJumpToLatest({
  visible,
  onJump,
  label,
  direction = 'down',
  needsYou = false,
  ariaLabel,
  busy = false
}: {
  visible: boolean
  onJump: () => void
  /** Jump to latest by default. */
  label?: string
  /** Which way the target is. */
  direction?: 'up' | 'down'
  /** Leads to a waiting question: its orange dot before the label. */
  needsYou?: boolean
  /** Names where it leads when the label alone doesn't. */
  ariaLabel?: string
  /** Its target is still being read. */
  busy?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const Arrow = direction === 'up' ? ArrowUp : ArrowDown
  return (
    <button
      type="button"
      data-shown={visible}
      data-native-chat-jump-latest=""
      inert={!visible}
      aria-hidden={!visible || undefined}
      aria-label={ariaLabel}
      aria-busy={busy || undefined}
      onMouseDown={keepFocus}
      onClick={onJump}
      className="absolute bottom-[max(calc(var(--spacing)*3),var(--native-chat-worker-jump-lift,0px))] left-1/2 flex h-8 -translate-x-1/2 items-center gap-1.5 rounded-full border border-transparent bg-[color-mix(in_srgb,var(--secondary-foreground)_5%,var(--secondary))] px-3 text-xs font-medium text-[color-mix(in_srgb,var(--secondary-foreground)_75%,black)] shadow-floating transition-[opacity,translate,background-color,color] duration-150 ease-out hover:bg-[color-mix(in_srgb,var(--secondary-foreground)_10%,var(--secondary))] dark:bg-accent dark:text-[color-mix(in_srgb,var(--accent-foreground)_75%,white)] dark:hover:bg-[color-mix(in_srgb,var(--accent-foreground)_8%,var(--accent))] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none [[data-worker-dock-cramped]_&]:invisible data-[shown=false]:pointer-events-none data-[shown=false]:translate-y-1 data-[shown=false]:opacity-0"
    >
      <Arrow aria-hidden className="size-3.5" />
      {needsYou ? (
        <span aria-hidden className="size-2.5 shrink-0 rounded-full bg-agent-question" />
      ) : null}
      <span>{label ?? t('components.native-chat.jumpToLatest', 'Jump to latest')}</span>
    </button>
  )
}
