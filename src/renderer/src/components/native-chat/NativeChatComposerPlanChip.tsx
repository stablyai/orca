import { useState } from 'react'
import { PencilRuler } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat/input/native-chat-session-options'
import { runSessionOptionSurfaceCall } from './native-chat-session-option-surface-call'
import { NativeChatComposerModeChip } from './NativeChatComposerModeChip'

export function useNativeChatPlanMode({
  surface,
  snapshot,
  focusComposer
}: {
  surface: SessionOptionsSurface | null
  snapshot: readonly SessionOptionDescriptor[]
  focusComposer?: () => void
}) {
  const [pending, setPending] = useState<string | null>(null)
  const descriptor = snapshot.find((entry) => entry.id === 'interactionMode')
  if (!surface || descriptor?.kind.type !== 'select' || descriptor.kind.currentValue !== 'plan') {
    return null
  }
  return {
    disabled: !descriptor.settable || pending !== null,
    exit: (): void => {
      runSessionOptionSurfaceCall('default', setPending, () =>
        surface.setOption('interactionMode', 'default')
      )
      focusComposer?.()
    }
  }
}

export function NativeChatComposerPlanChip({
  control,
  onExit
}: {
  control: ReturnType<typeof useNativeChatPlanMode>
  onExit?: () => void
}): React.JSX.Element | null {
  if (!control) {
    return null
  }
  return (
    <NativeChatComposerModeChip
      icon={PencilRuler}
      label={translate('components.native-chat.composer.planMode', 'Plan')}
      exitLabel={translate('components.native-chat.composer.exitPlanMode', 'Exit plan mode')}
      disabled={control.disabled}
      onExit={() => {
        control.exit()
        onExit?.()
      }}
    />
  )
}
