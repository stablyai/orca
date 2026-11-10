import { useId } from 'react'
import { Switch } from '@/components/ui/switch'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { formatUsageLimitResetClock } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'

export type NativeChatUsageLimitAutoContinueState =
  | { kind: 'off'; resetsAt: number }
  | { kind: 'scheduled'; resetsAt: number; cancel: () => void; cancelDisabled?: boolean }
  | { kind: 'cancelled'; resetsAt: number }

/** The last line of a usage-limit row: whether Orca will send the continue itself at the reset.
 *  Off writes the global setting; once scheduled, off cancels only this chat. */
export function NativeChatUsageLimitAutoContinue({
  state
}: {
  state: NativeChatUsageLimitAutoContinueState
}): React.JSX.Element {
  const t = useTranslate()
  const id = useId()
  const setting = useAppStore((s) => s.settings?.nativeChatAutoContinueAfterUsageLimit)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const time = formatUsageLimitResetClock(state.resetsAt)
  // The host publishes "scheduled" after the setting lands; follow the setting until then.
  const checked = state.kind === 'scheduled' || (state.kind === 'off' && setting === true)
  const label =
    state.kind === 'scheduled'
      ? t(
          'components.native-chat.usageLimitAutoContinue.scheduled',
          'Orca will continue this chat at {{time}}.',
          { time }
        )
      : state.kind === 'cancelled'
        ? t(
            'components.native-chat.usageLimitAutoContinue.cancelled',
            "Orca won't continue this chat automatically."
          )
        : t(
            'components.native-chat.usageLimitAutoContinue.continueAt',
            'Continue automatically at {{time}}',
            { time }
          )
  return (
    <div className="ml-6 flex items-center gap-2 text-xs text-chat-foreground-faint">
      <Switch
        id={id}
        size="compact"
        checked={checked}
        disabled={
          state.kind === 'cancelled' ||
          (state.kind === 'scheduled' ? state.cancelDisabled : setting === undefined)
        }
        onCheckedChange={(next) => {
          if (state.kind === 'scheduled') {
            state.cancel()
          } else if (state.kind === 'off') {
            void updateSettings({ nativeChatAutoContinueAfterUsageLimit: next })
          }
        }}
      />
      <label htmlFor={id}>{label}</label>
    </div>
  )
}
