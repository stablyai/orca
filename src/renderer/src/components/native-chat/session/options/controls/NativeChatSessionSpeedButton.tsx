import { ChevronDown, Zap } from 'lucide-react'
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
import { isFastServiceTier } from '../../../../../../../shared/agent-session/options/structured-agent-session-discovered-model'
import { sayNativeChatSessionOptionTranslated as say } from './native-chat-session-option-labels-text'

const STANDARD_TIER = 'default'

/** Standard plus the other tiers, or null when the select is not a speed choice with any. */
export function speedButtonTiers(
  descriptor: SessionOptionDescriptor
): { standard: SessionOptionSelectChoice; tiers: SessionOptionSelectChoice[] } | null {
  if (descriptor.id !== 'serviceTier' || descriptor.kind.type !== 'select') {
    return null
  }
  const standard = descriptor.kind.choices.find((choice) => choice.value === STANDARD_TIER)
  const tiers = descriptor.kind.choices.filter((choice) => choice.value !== STANDARD_TIER)
  return standard && tiers.length > 0 ? { standard, tiers } : null
}

/** A lone Fast tier toggles like Claude's Fast; anything else opens a list instead of a segmented switcher. */
export function NativeChatSessionSpeedButton(props: {
  label: string
  standard: SessionOptionSelectChoice
  tiers: SessionOptionSelectChoice[]
  current: string | undefined
  disabled: boolean
  onSet: (value: SessionOptionValue) => void
}): React.JSX.Element {
  const { label, standard, tiers, current, disabled, onSet } = props
  const picked = tiers.find((choice) => choice.value === current)
  // An unknown tier names no choice, rather than claiming Standard.
  const shown = picked ?? (current === standard.value ? standard : undefined)
  const nameOf = (choice: SessionOptionSelectChoice) =>
    nativeChatSessionChoiceLabel(choice, say, 'serviceTier')
  // Only Fast takes the toggle and bolt; Flex and other tiers are picked from the list.
  if (tiers.length === 1 && isFastServiceTier(tiers[0])) {
    const only = tiers[0]
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
          aria-label={shown ? `${label}: ${nameOf(shown)}` : label}
          // A menu trigger's data-state names open, not on, so pressed rides on data-pressed.
          data-pressed={Boolean(picked && isFastServiceTier(picked))}
          className={toggleVariants({ variant: 'chip', size: 'xs' })}
        >
          {picked && isFastServiceTier(picked) ? <Zap className="size-3" /> : null}
          {shown ? nameOf(shown) : label}
          <ChevronDown className="size-3 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" collisionPadding={8} className="min-w-56">
        <DropdownMenuRadioGroup aria-label={label} value={shown?.value ?? ''} onValueChange={onSet}>
          {[standard, ...tiers].map((choice) => (
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
