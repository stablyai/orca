import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { parseStructuredModelChoice } from '../../../../shared/structured-agent-session-switchable-models'
import { nativeChatModelPillLabel } from './native-chat-session-option-labels'

function ProviderIcon({ value }: { value: string }): React.JSX.Element | null {
  const parsed = parseStructuredModelChoice(value)
  return parsed ? (
    <span className="inline-flex size-4 shrink-0 items-center justify-center" aria-hidden>
      <AgentIcon agent={parsed.agent} size={16} />
    </span>
  ) : null
}

export function NativeChatModelPicker({
  descriptor,
  disabled,
  defaultOpen,
  onSelect
}: {
  descriptor: SessionOptionDescriptor
  disabled: boolean
  defaultOpen: boolean
  onSelect: (value: string) => void
}): React.JSX.Element | null {
  const [open, setOpen] = useState(defaultOpen)
  if (descriptor.kind.type !== 'select') {
    return null
  }
  const { choices, currentValue } = descriptor.kind
  const groups = [...new Set(choices.map((choice) => choice.group))]
  const label = nativeChatModelPillLabel(descriptor)
  const modelLabel = translate('components.native-chat.composer.model', 'Model')
  const searchLabel = translate('components.native-chat.composer.searchModels', 'Search models')
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              aria-label={label === modelLabel ? modelLabel : `${modelLabel} ${label}`}
              className="max-w-48 text-muted-foreground"
            >
              {currentValue ? <ProviderIcon value={currentValue} /> : null}
              <span className="truncate">{label}</span>
              <ChevronDown className="size-3" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{modelLabel}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" side="top" collisionPadding={8} className="w-80 p-0">
        <Command>
          <CommandInput
            placeholder={searchLabel}
            aria-label={searchLabel}
            className="h-8 text-xs"
          />
          <CommandList>
            <CommandEmpty>
              {translate('components.native-chat.composer.noMatchingModels', 'No matching models')}
            </CommandEmpty>
            {groups.map((group) => (
              <CommandGroup key={group ?? 'models'} heading={group}>
                {choices
                  .filter((choice) => choice.group === group)
                  .map((choice) => (
                    <CommandItem
                      key={choice.value}
                      value={choice.value}
                      keywords={[choice.label, choice.description ?? '', group ?? '']}
                      disabled={disabled || !descriptor.settable || choice.disabled}
                      data-current={choice.value === currentValue}
                      className="jump-palette-item text-xs"
                      onSelect={() => {
                        setOpen(false)
                        onSelect(choice.value)
                      }}
                    >
                      <ProviderIcon value={choice.value} />
                      <div className="min-w-0 flex-1 py-0.5">
                        <div>{choice.label}</div>
                        {choice.description ? (
                          <div className="text-xs text-muted-foreground">{choice.description}</div>
                        ) : null}
                      </div>
                      {choice.value === currentValue ? <Check className="size-3.5" /> : null}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
