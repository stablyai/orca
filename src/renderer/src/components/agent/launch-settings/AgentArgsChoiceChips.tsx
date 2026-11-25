import type { Ref } from 'react'
import { X } from 'lucide-react'
import { useTranslate } from '../../../i18n/use-translate'
import { Tooltip, TooltipContent, TooltipTrigger } from '../../ui/tooltip'
import type { AgentArgsChoice } from './agent-args-choice'

function AgentArgsChoiceChip({
  label,
  flag,
  onRemove,
  disabled,
  chipRef,
  buttonRef,
  choiceKey,
  source
}: {
  label: string
  flag: string
  onRemove: () => void
  disabled?: boolean
  chipRef?: Ref<HTMLSpanElement>
  buttonRef?: Ref<HTMLButtonElement>
  choiceKey: string
  source?: 'arguments'
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          ref={chipRef}
          className="flex h-5 min-w-0 max-w-full items-center gap-1 rounded bg-muted px-1.5 font-mono text-xs leading-5 text-foreground/80 focus-within:ring-2 focus-within:ring-ring"
        >
          <span className="truncate">{flag}</span>
          <button
            ref={buttonRef}
            type="button"
            disabled={disabled}
            onClick={onRemove}
            onKeyDown={(event) => {
              if (event.key === 'Backspace') {
                event.preventDefault()
                if (
                  !disabled &&
                  !event.repeat &&
                  !event.altKey &&
                  !event.ctrlKey &&
                  !event.metaKey
                ) {
                  onRemove()
                }
              }
            }}
            aria-label={
              source === 'arguments' || choiceKey !== 'permissionMode'
                ? t('settings.agents.choiceChipRemove', 'Remove {{flag}}', { flag })
                : t(
                    'settings.agents.permissionChipRemove',
                    "Remove {{flag}} and use {{agent}}'s own settings",
                    { flag, agent: label }
                  )
            }
            className="rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          >
            <X className="size-3" />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent>
        {source === 'arguments'
          ? t('agentPicker.argumentsHint', 'Applies only to CLI launches.')
          : choiceKey !== 'permissionMode'
            ? t(
                'settings.agents.choiceChipTooltip',
                'Added by {{choice}}. Remove it to use the default.',
                {
                  choice:
                    choiceKey === 'model'
                      ? t('settings.sourceControl.actionModel.model', 'Model')
                      : t('settings.sourceControl.actionModel.effort', 'Effort')
                }
              )
            : t(
                'settings.agents.permissionChipTooltip',
                'Added by Permissions. Remove it to use {{agent}}’s own settings.',
                { agent: label }
              )}
      </TooltipContent>
    </Tooltip>
  )
}

export function AgentArgsChoiceChips({
  chips,
  disabled,
  chipRef,
  buttonRef,
  onRemove
}: {
  chips: readonly AgentArgsChoice[]
  disabled?: boolean
  chipRef?: Ref<HTMLSpanElement>
  buttonRef?: Ref<HTMLButtonElement>
  onRemove: (chip: AgentArgsChoice) => void
}): React.JSX.Element {
  return (
    <span
      ref={chipRef}
      className="relative z-10 -mb-5 flex h-5 w-fit max-w-full items-center gap-1"
    >
      {chips.map((chip, index) => (
        <AgentArgsChoiceChip
          key={chip.key}
          choiceKey={chip.key}
          label={chip.label}
          flag={chip.flag}
          source={chip.source}
          disabled={disabled}
          buttonRef={index === chips.length - 1 ? buttonRef : undefined}
          onRemove={() => onRemove(chip)}
        />
      ))}
    </span>
  )
}
