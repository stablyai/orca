import { Settings } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { formatUsageLimitResetClock } from '../../../../shared/agent-session-usage-limit'
import { NATIVE_CHAT_USAGE_LIMIT_CONTINUE_SETTING_SECTION_ID } from '../settings/native-chat-usage-limit-continue-setting-target'

export type NativeChatUsageLimitAutoContinueState =
  | { kind: 'off' }
  | { kind: 'scheduled'; resetsAt: number; cancel: () => void; cancelDisabled?: boolean }
  | { kind: 'cancelled' }

function openUsageLimitContinueSetting(): void {
  const { openSettingsTarget, openSettingsPage } = useAppStore.getState()
  openSettingsTarget({
    pane: 'chat',
    repoId: null,
    sectionId: NATIVE_CHAT_USAGE_LIMIT_CONTINUE_SETTING_SECTION_ID
  })
  openSettingsPage()
}

const LINK_CLASS =
  'inline-flex items-center gap-1 text-xs text-chat-foreground-faint underline underline-offset-2 hover:text-chat-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/** The last line of a usage-limit row: whether Orca will send the continue itself at the reset. */
export function NativeChatUsageLimitAutoContinue({
  state
}: {
  state: NativeChatUsageLimitAutoContinueState
}): React.JSX.Element {
  if (state.kind === 'off') {
    return (
      <div className="ml-6">
        <button type="button" className={LINK_CLASS} onClick={openUsageLimitContinueSetting}>
          <Settings aria-hidden="true" className="size-3.5" />
          {translate(
            'components.native-chat.usageLimitAutoContinue.openSetting',
            'Continue automatically when limits reset'
          )}
        </button>
      </div>
    )
  }
  if (state.kind === 'cancelled') {
    return (
      <p className="ml-6 text-xs text-chat-foreground-faint">
        {translate(
          'components.native-chat.usageLimitAutoContinue.cancelled',
          "Orca won't continue this chat automatically."
        )}
      </p>
    )
  }
  return (
    <p className="ml-6 text-xs text-chat-foreground-faint">
      {translate(
        'components.native-chat.usageLimitAutoContinue.scheduled',
        'Orca will continue this chat at {{time}}.',
        { time: formatUsageLimitResetClock(state.resetsAt) }
      )}
      <button
        type="button"
        className="ml-2 text-2xs text-chat-foreground-faint hover:text-chat-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        disabled={state.cancelDisabled}
        onClick={state.cancel}
      >
        {translate('components.native-chat.usageLimitAutoContinue.cancel', "Don't continue")}
      </button>
    </p>
  )
}
