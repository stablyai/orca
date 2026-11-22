import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../../shared/native-chat/input/native-chat-session-options'
import { NativeChatSessionOptionChoiceBody } from './NativeChatSessionOptionChoiceBody'
import { runSessionOptionSurfaceCall } from './native-chat-session-option-surface-call'

export function NativeChatAgentPicker({
  descriptor,
  surface
}: {
  descriptor: SessionOptionDescriptor
  surface: SessionOptionsSurface
}): React.JSX.Element | null {
  const t = useTranslate()
  const [pending, setPending] = useState<string | null>(null)
  if (descriptor.kind.type !== 'select' || descriptor.transport !== 'agent-session') {
    return null
  }
  const { currentValue, choices } = descriptor.kind
  const title = t('components.native-chat.composer.agent', 'Agent')
  const selected = choices.find((choice) => choice.value === currentValue)
  const selectedLabel = selected?.label ?? currentValue
  const label = selectedLabel
    ? t('components.native-chat.composer.agentValue', 'Agent: {{agent}}', {
        agent: selectedLabel
      })
    : title
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={!descriptor.settable || pending !== null}>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-busy={pending !== null || undefined}
          className="max-w-48"
        >
          <span data-composer-label className="truncate">
            {label}
          </span>
          <ChevronDown className="size-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top">
        <DropdownMenuLabel>
          {title}
          <div className="text-xs font-normal text-muted-foreground">
            {t(
              'components.native-chat.composer.agentSelectionPersists',
              'Changes apply to your next message and stay until you select another agent.'
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup value={currentValue ?? ''}>
          {choices.map((choice) => (
            <DropdownMenuRadioItem
              key={choice.value}
              value={choice.value}
              onSelect={() => {
                if (pending === null) {
                  runSessionOptionSurfaceCall(choice.value, setPending, () =>
                    surface.setOption(descriptor.id, choice.value)
                  )
                }
              }}
            >
              <NativeChatSessionOptionChoiceBody
                label={choice.label}
                description={choice.description}
              />
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
