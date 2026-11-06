import { memo, useState } from 'react'
import { Bot, PencilRuler } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useUiLanguageRevision } from '@/i18n/use-ui-language-revision'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat/input/native-chat-session-options'
import { runSessionOptionSurfaceCall } from './native-chat-session-option-surface-call'

export function useNativeChatInteractionMode({
  surface,
  snapshot,
  focusComposer
}: {
  surface: SessionOptionsSurface | null
  snapshot: readonly SessionOptionDescriptor[]
  focusComposer?: () => void
}) {
  useUiLanguageRevision()
  const [pending, setPending] = useState<string | null>(null)
  const descriptor = snapshot.find((entry) => entry.id === 'interactionMode')
  if (!surface || descriptor?.kind.type !== 'select') {
    return null
  }
  const plan = descriptor.kind.currentValue === 'plan'
  const Icon = plan ? PencilRuler : Bot
  const label = plan
    ? translate('components.native-chat.composer.planMode', 'Plan')
    : translate('components.native-chat.composer.buildMode', 'Build')
  return {
    plan,
    Icon,
    label,
    disabled: !descriptor.settable || pending !== null,
    select: (value: 'default' | 'plan'): void => {
      runSessionOptionSurfaceCall(value, setPending, () =>
        surface.setOption('interactionMode', value)
      )
      focusComposer?.()
    }
  }
}

export function NativeChatInteractionModeButton({
  control
}: {
  control: ReturnType<typeof useNativeChatInteractionMode>
}): React.JSX.Element | null {
  if (!control) {
    return null
  }
  const { plan, Icon, label, disabled, select } = control
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={label}
          aria-pressed={plan}
          disabled={disabled}
          onClick={() => select(plan ? 'default' : 'plan')}
        >
          <Icon className="size-3.5" aria-hidden />
          <span data-composer-label>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {translate('components.native-chat.composer.modeNextTurn', 'Applies to the next turn')}
      </TooltipContent>
    </Tooltip>
  )
}

export const NativeChatInteractionModeToggle = memo(function NativeChatInteractionModeToggle(
  props: Parameters<typeof useNativeChatInteractionMode>[0]
): React.JSX.Element | null {
  return <NativeChatInteractionModeButton control={useNativeChatInteractionMode(props)} />
})
