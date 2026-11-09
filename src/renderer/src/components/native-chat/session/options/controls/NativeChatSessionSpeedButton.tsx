import { ChevronDown, Zap } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Toggle, toggleVariants } from '@/components/ui/toggle'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type {
  SessionOptionDescriptor,
  SessionOptionSelectChoice,
  SessionOptionValue
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { nativeChatSessionChoiceLabel } from '../../../../../../../shared/native-chat/input/native-chat-session-option-labels'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'

const STANDARD_TIER = 'default'

/** Standard plus the faster tiers, or null when the select is not a speed choice with any. */
export function speedButtonTiers(
  descriptor: SessionOptionDescriptor
): { standard: SessionOptionSelectChoice; faster: SessionOptionSelectChoice[] } | null {
  if (descriptor.id !== 'serviceTier' || descriptor.kind.type !== 'select') {
    return null
  }
  const standard = descriptor.kind.choices.find((choice) => choice.value === STANDARD_TIER)
  const faster = descriptor.kind.choices.filter((choice) => choice.value !== STANDARD_TIER)
  return standard && faster.length > 0 ? { standard, faster } : null
}

/** One faster tier toggles like Claude's Fast; several open a list instead of a segmented switcher. */
export function NativeChatSessionSpeedButton(props: {
  label: string
  standard: SessionOptionSelectChoice
  faster: SessionOptionSelectChoice[]
  current: string | undefined
  disabled: boolean
  onSet: (value: SessionOptionValue) => void
}): React.JSX.Element {
  const { label, standard, faster, current, disabled, onSet } = props
  const picked = faster.find((choice) => choice.value === current)
  const nameOf = (choice: SessionOptionSelectChoice) =>
    nativeChatSessionChoiceLabel(choice, say, 'serviceTier')
  if (faster.length === 1) {
    const only = faster[0]
    return (
      <Toggle
        variant="chip"
        size="xs"
        pressed={Boolean(picked)}
        disabled={disabled}
        onPressedChange={(pressed) => onSet(pressed ? only.value : standard.value)}
      >
        <Zap className="size-3" />
        {nameOf(only)}
      </Toggle>
    )
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={`${label}: ${nameOf(picked ?? standard)}`}
          // Mirrors the chip's pressed fill; a menu trigger's data-state names open, not on.
          className={cn(
            toggleVariants({ variant: 'chip', size: 'xs' }),
            'gap-1',
            picked && 'border-transparent bg-foreground/12 text-foreground dark:bg-accent'
          )}
        >
          <Zap className="size-3" />
          {nameOf(picked ?? standard)}
          <ChevronDown className="size-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="min-w-56">
        <DropdownMenuRadioGroup value={picked?.value ?? standard.value} onValueChange={onSet}>
          {[standard, ...faster].map((choice) => (
            <DropdownMenuRadioItem key={choice.value} value={choice.value}>
              <span className="flex min-w-0 flex-col gap-0.5">
                <span>{nameOf(choice)}</span>
                {choice.description ? (
                  <span className="text-xs text-muted-foreground">{choice.description}</span>
                ) : null}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
