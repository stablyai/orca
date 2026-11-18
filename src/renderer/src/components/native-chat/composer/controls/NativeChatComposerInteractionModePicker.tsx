import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import {
  findAgentSessionInteractionMode,
  isAgentSessionInteractionMode
} from '../../../../../../shared/agent-session/options/permissions/agent-session-interaction-mode'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { useNativeChatPickerFocusReturn } from '../focus/native-chat-picker-focus-return'
import { sayNativeChatSessionOptionTranslated as say } from '../../session/options/controls/native-chat-session-option-labels-text'
import { runSessionOptionSurfaceCall } from '../../session/options/controls/native-chat-session-option-surface-call'

export function useNativeChatInteractionMode(
  surface: SessionOptionsSurface | null,
  snapshot: readonly SessionOptionDescriptor[]
) {
  const [pending, setPending] = useState<string | null>(null)
  const descriptor = findAgentSessionInteractionMode(snapshot)
  if (!surface || !descriptor) {
    return null
  }
  return {
    disabled: !descriptor.settable || pending !== null,
    current: descriptor.kind.currentValue === 'plan' ? 'plan' : 'default',
    set: (value: string): boolean => {
      if (!descriptor.settable || pending !== null || !isAgentSessionInteractionMode(value)) {
        return false
      }
      runSessionOptionSurfaceCall(value, setPending, () => surface.setOption(descriptor.id, value))
      return true
    }
  }
}

export function NativeChatComposerInteractionModePicker({
  control,
  focusComposer,
  onPick
}: {
  control: NonNullable<ReturnType<typeof useNativeChatInteractionMode>>
  focusComposer?: () => void
  onPick?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const { triggerRef, notePick, onInteractOutside, onCloseAutoFocus } =
    useNativeChatPickerFocusReturn(focusComposer)
  const label = say(control.current === 'plan' ? 'planMode' : 'buildMode')
  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          ref={triggerRef}
          disabled={control.disabled}
          aria-label={t(
            'components.native-chat.composer.pillAccessibleName',
            '{{value0}} {{value1}}',
            {
              value0: say('interactionMode'),
              value1: label
            }
          )}
        >
          <span className="flex items-center gap-1">
            <span className="text-chat-foreground">{label}</span>
            <ChevronDown className="size-3" />
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side="top"
        onInteractOutside={onInteractOutside}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DropdownMenuRadioGroup
          value={control.current}
          onValueChange={(value) => {
            if (control.set(value)) {
              notePick()
              onPick?.()
            }
          }}
        >
          <DropdownMenuRadioItem value="default">{say('buildMode')}</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="plan">{say('planMode')}</DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
