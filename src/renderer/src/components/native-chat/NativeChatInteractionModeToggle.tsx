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

export const NativeChatInteractionModeToggle = memo(function NativeChatInteractionModeToggle({
  surface,
  snapshot,
  focusComposer
}: {
  surface: SessionOptionsSurface | null
  snapshot: readonly SessionOptionDescriptor[]
  focusComposer?: () => void
}): React.JSX.Element | null {
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
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          aria-label={label}
          aria-pressed={plan}
          disabled={!descriptor.settable || pending !== null}
          onClick={() => {
            const value = plan ? 'default' : 'plan'
            runSessionOptionSurfaceCall(value, setPending, () =>
              surface.setOption('interactionMode', value)
            )
            focusComposer?.()
          }}
        >
          <Icon className="size-3.5" aria-hidden />
          <span>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {translate('components.native-chat.composer.modeNextTurn', 'Applies to the next turn')}
      </TooltipContent>
    </Tooltip>
  )
})
