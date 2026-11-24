import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatVisualOwnerContext } from '../../media/visuals/native-chat-visual-owner'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  nativeChatAppearanceStyle
} from '../../appearance/native-chat-appearance-style'

// Every answer keeps at least the same gap above its actions, whatever it ends with.
const owner = {
  target: { kind: 'local' as const },
  sessionId: 'actions-gap',
  worktreeId: 'actions-gap'
}

const ORDER = ['ask', 'reply', 'check', 'last']

function message(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return {
    id,
    role,
    timestamp: 1_800_000_000_000 + ORDER.indexOf(id) * 60_000,
    source: 'transcript',
    blocks: [{ type: 'text', text }]
  }
}

function ActionsGap({ last }: { last: string }): React.JSX.Element {
  const session: NativeChatLiveSession = {
    agent: 'claude',
    sessionId: 'actions-gap',
    status: 'ready',
    readPhase: 'ready',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: async () => 'applied',
    messages: [
      message('ask', 'user', 'Anything new on the board?'),
      message('reply', 'assistant', 'Two items moved to done.'),
      message('check', 'user', 'Check again.'),
      message('last', 'assistant', last)
    ]
  }
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  return (
    <NativeChatVisualOwnerContext.Provider value={owner}>
      <div
        className={`${NATIVE_CHAT_APPEARANCE_ROOT_CLASS} flex h-[420px] flex-col`}
        style={nativeChatAppearanceStyle({ theme })}
      >
        <NativeChatMessageList session={session} isWorking={false} expandSignal={false} />
      </div>
    </NativeChatVisualOwnerContext.Provider>
  )
}

export const paragraph = defineFixture({
  width: 560,
  render: () => <ActionsGap last="Nothing changed since the last check." />
})

export const list = defineFixture({
  width: 560,
  render: () => <ActionsGap last={'Two items moved:\n\n- Share dialog\n- Release notes'} />
})

export const code = defineFixture({
  width: 560,
  render: () => <ActionsGap last={'Run this:\n\n```sh\npnpm test\n```'} />
})
