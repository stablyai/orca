import { ChevronDown, ChevronUp } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import type { InteractivePromptCard } from './native-chat-interactive-prompt'

/** A prompt card's one collapse affordance; folding or unfolding writes nothing to the agent. */
export function NativeChatPromptCollapseToggle({
  expanded,
  disabled = false,
  onToggle
}: {
  expanded: boolean
  disabled?: boolean
  onToggle: () => void
}): React.JSX.Element {
  const label = expanded
    ? translate('components.native-chat.prompt.collapse', 'Collapse')
    : translate('components.native-chat.prompt.expand', 'Expand')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
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
  onExpand
}: {
  card: NonNullable<InteractivePromptCard>
  onExpand: () => void
}): React.JSX.Element {
  const title =
    card.kind === 'approval' ? card.approval.title : (card.prompt.questions[0]?.question ?? '')
  return (
    <div className="shrink-0 bg-chat-canvas">
      <div className="mx-auto w-full max-w-(--chat-content-max-width) px-3 pt-2 sm:px-4">
        <div
          data-native-chat-prompt-strip="true"
          className="flex items-center gap-2 rounded-lg border border-input bg-card py-1 pr-1.5 pl-3.5 shadow-xs"
        >
          <p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{title}</p>
          <NativeChatPromptCollapseToggle expanded={false} onToggle={onExpand} />
        </div>
      </div>
    </div>
  )
}
