import { useState } from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { AgentTypeIcon } from '@/lib/agent-type-icon'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem
} from '../ui/command'
import { useNativeChatPickerFocusReturn } from '../native-chat/native-chat-picker-focus-return'
import {
  agentPickerEffectiveChoices,
  agentPickerModels,
  type AgentPickerEntry,
  type AgentPickerDraft
} from '../../../../shared/agent-launch-picker'

export function ThreadLaunchPicker({
  entries,
  draft,
  onSelect,
  onModel,
  focusComposer
}: {
  entries: AgentPickerEntry[]
  draft: AgentPickerDraft
  onSelect: (entry: AgentPickerEntry) => void
  onModel: (model: string) => void
  focusComposer: () => void
}) {
  const [open, setOpen] = useState(false)
  const focus = useNativeChatPickerFocusReturn(focusComposer)
  const entry = entries.find((e) => e.agent === draft.agent)
  const choices = entry ? agentPickerEffectiveChoices(entry, draft) : draft.choices
  const models = entry ? agentPickerModels(entry) : []
  const model = choices.model ?? models.find((m) => m.isDefault)?.id
  const label = models.find((m) => m.id === model)?.label ?? model ?? entry?.label ?? draft.agent
  const pick = (action: () => void) => {
    focus.notePick()
    action()
    setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          ref={focus.triggerRef}
          type="button"
          variant="ghost"
          size="xs"
          disabled={!entries.length}
          aria-label={translate('threads.chooseAgent', 'Agent {{model}}', { model: label })}
          className="max-w-64"
        >
          <span className="truncate text-chat-foreground">{label}</span>
          <ChevronDown className="size-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-0"
        onInteractOutside={focus.onInteractOutside}
        onCloseAutoFocus={focus.onCloseAutoFocus}
      >
        <Command>
          <CommandInput
            placeholder={translate('agentPicker.search', 'Search agents and setups…')}
          />
          <CommandList>
            <CommandEmpty>
              {translate('agentPicker.noModels', 'No models match your search.')}
            </CommandEmpty>
            <CommandGroup heading={translate('threads.agent', 'Agent')}>
              {entries.map((item) => {
                const effective = item.agent === draft.agent ? choices : item.structured
                const model =
                  effective.model ?? agentPickerModels(item).find((m) => m.isDefault)?.label
                return (
                  <CommandItem
                    key={item.agent}
                    value={item.agent}
                    keywords={[item.label, model ?? '']}
                    onSelect={() => pick(() => onSelect(item))}
                  >
                    <AgentTypeIcon agentType={item.agent} size={14} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span>{item.label}</span>
                      <span className="truncate text-xs text-muted-foreground">{model}</span>
                    </span>
                    {item.agent === draft.agent ? <Check className="size-3.5" /> : null}
                  </CommandItem>
                )
              })}
            </CommandGroup>
            {entry ? (
              <CommandGroup heading={translate('components.native-chat.composer.model', 'Model')}>
                {models
                  .filter((m) => !m.hidden)
                  .map((m) => (
                    <CommandItem
                      key={m.id}
                      value={`model:${m.id}`}
                      keywords={[m.label]}
                      onSelect={() => pick(() => onModel(m.id))}
                    >
                      {m.label}
                      {m.id === model ? <Check className="ml-auto size-3.5" /> : null}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
