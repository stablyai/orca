import { PencilRuler } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../../../shared/native-chat/input/native-chat-session-options'
import { runSessionOptionSurfaceCall } from '../../session/options/controls/native-chat-session-option-surface-call'
import { NativeChatComposerModeChip } from './NativeChatComposerModeChip'
import { useNativeChatViewGuard } from '../../pane/ownership/native-chat-view-memory'

export function useNativeChatPlanMode({
  surface,
  snapshot,
  focusComposer
}: {
  surface: SessionOptionsSurface | null
  snapshot: readonly SessionOptionDescriptor[]
  focusComposer?: () => void
}) {
  // Kept with the chat tab: a view released while plan mode is being left returns still pending.
  const [pending, setPending] = useNativeChatViewGuard<string | null>('plan-mode-exit', null)
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
  const t = useTranslate()
  if (!control) {
    return null
  }
  return (
    <NativeChatComposerModeChip
      icon={PencilRuler}
      label={t('components.native-chat.composer.planMode', 'Plan')}
      exitLabel={t('components.native-chat.composer.exitPlanMode', 'Exit plan mode')}
      disabled={control.disabled}
      onExit={() => {
        control.exit()
        onExit?.()
      }}
    />
  )
}
