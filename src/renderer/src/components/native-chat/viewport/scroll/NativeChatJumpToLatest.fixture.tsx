import { defineFixture } from '../../../../component-fixtures/component-fixture'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  nativeChatAppearanceStyle
} from '../../appearance/native-chat-appearance-style'
import { NativeChatJumpToLatest } from './NativeChatJumpToLatest'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { resolveNativeChatAppearanceSettings } from '../../../../../../shared/native-chat/settings/native-chat-appearance-settings'

const PROSE = [
  'The reconnect path retries the relay handshake before it replays buffered output, so a stalled socket shows up as a slow first frame rather than a dropped session.',
  'I traced the stall to the worktree sync: it waits for the remote index lock, and the lock holder is the previous connection that never released it after the laptop slept.',
  'Releasing the lock on disconnect fixes the overnight case. The remaining risk is a second client attaching during the grace window, which the lease check already rejects.',
  'Next I will run the remote suite against a paired Linux host and confirm the replay order matches the local transcript.'
]

function Transcript({ settings }: { settings?: Partial<GlobalSettings> }): React.JSX.Element {
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  const style = nativeChatAppearanceStyle({ theme, ...settings })
  return (
    <div
      className={`${NATIVE_CHAT_APPEARANCE_ROOT_CLASS} relative h-56 overflow-hidden px-4 pt-3 text-sm text-chat-foreground`}
      style={style}
      data-native-chat-scheme={style.colorScheme}
    >
      <div className="space-y-3">
        {PROSE.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <NativeChatJumpToLatest visible onJump={() => {}} />
    </div>
  )
}

export const overTranscript = defineFixture({ width: 640, render: () => <Transcript /> })

export const narrow = defineFixture({ width: 360, render: () => <Transcript /> })

// Chat-only Match Terminal derives its own surfaces from a dim terminal palette, outside the theme check.
export const matchTerminal = defineFixture({
  width: 640,
  render: () => (
    <Transcript
      settings={{
        nativeChatAppearance: resolveNativeChatAppearanceSettings({ matchTerminalInterface: true }),
        terminalColorOverrides: { background: '#333333', foreground: '#a1a1a1' }
      }}
    />
  )
})
