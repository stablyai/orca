import { useContext, useLayoutEffect, useRef, type Ref } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'
import type { InteractivePromptCard } from '../../../../../shared/native-chat/input/native-chat-interactive-prompt'
import { cn } from '@/lib/class-names'
import { NativeChatInSubagentSheet } from '../subagents/native-chat-subagent-sheet-context'

/** A prompt card's centered column: its slot's own inset, or the rows' text column inside a subagent sheet. */
export function usePromptCardColumn(slotInset: string): string {
  const inSheet = useContext(NativeChatInSubagentSheet)
  return cn(
    'mx-auto w-full max-w-(--chat-content-max-width) pt-2',
    inSheet ? 'px-[5px]' : slotInset
  )
}

/** A prompt card's one collapse affordance; folding or unfolding writes nothing to the agent. */
export function NativeChatPromptCollapseToggle({
  expanded,
  disabled = false,
  onToggle,
  ref,
  wantsFocus = false
}: {
  expanded: boolean
  disabled?: boolean
  onToggle: () => void
  ref?: Ref<HTMLButtonElement>
  /** Names this control as the pane's prompt focus target, as an open card is. */
  wantsFocus?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const label = expanded
    ? t('components.native-chat.prompt.collapse', 'Collapse')
    : t('components.native-chat.prompt.expand', 'Expand')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          ref={ref}
          data-native-chat-prompt-card-focus={wantsFocus || undefined}
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          aria-expanded={expanded}
          disabled={disabled}
          onClick={onToggle}
        >
          {expanded ? <ChevronDown /> : <ChevronUp />}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
        {expanded ? <ShortcutKeyCombo keys={['Esc']} /> : null}
      </TooltipContent>
    </Tooltip>
  )
}

/** A collapsed prompt above the usable composer; expanding gives it the input again. */
export function NativeChatPromptStrip({
  card,
  onExpand,
  takeFocus = false
}: {
  card: NonNullable<InteractivePromptCard>
  onExpand: () => void
  /** No composer returns to hold focus, so the strip keeps it off the hidden card. */
  takeFocus?: boolean
}): React.JSX.Element {
  const toggleRef = useRef<HTMLButtonElement>(null)
  useLayoutEffect(() => {
    if (takeFocus) {
      toggleRef.current?.focus()
    }
  }, [takeFocus])
  const title =
    card.kind === 'approval' ? card.approval.title : (card.prompt.questions[0]?.question ?? '')
  return (
    <div className="shrink-0 bg-chat-pane">
      <div className="mx-auto w-full max-w-(--chat-content-max-width) px-3 pt-2 sm:px-4">
        <div
          data-native-chat-prompt-strip="true"
          className="flex items-center gap-2 rounded-lg border border-input bg-card py-1 pr-1.5 pl-3.5 shadow-xs"
        >
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</p>
          <NativeChatPromptCollapseToggle
            ref={toggleRef}
            wantsFocus={takeFocus}
            expanded={false}
            onToggle={onExpand}
          />
        </div>
      </div>
    </div>
  )
}
