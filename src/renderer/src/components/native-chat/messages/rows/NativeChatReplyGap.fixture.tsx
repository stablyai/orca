import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { NativeChatVisualOwnerContext } from '../../media/visuals/native-chat-visual-owner'
import {
  NATIVE_CHAT_APPEARANCE_ROOT_CLASS,
  nativeChatAppearanceStyle
} from '../../appearance/native-chat-appearance-style'

const owner = {
  target: { kind: 'local' as const },
  sessionId: 'reply-gap',
  worktreeId: 'reply-gap'
}

function message(id: string, role: NativeChatMessage['role'], text: string): NativeChatMessage {
  return {
    id,
    role,
    timestamp:
      1_800_000_000_000 + ['earlier-ask', 'earlier-reply', 'ask', 'reply'].indexOf(id) * 60_000,
    source: 'transcript',
    blocks: [{ type: 'text', text }]
  }
}

function ReplyGap({ visual }: { visual: boolean }): React.JSX.Element {
  const session: NativeChatLiveSession = {
    agent: 'codex',
    sessionId: 'reply-gap',
    status: 'ready',
    readPhase: 'ready',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: async () => 'applied',
    messages: [
      message('earlier-ask', 'user', 'Review the earlier result.'),
      message(
        'earlier-reply',
        'assistant',
        'The earlier result is ready.\n\nThe inputs have been checked.\n\nThe comparison is complete.\n\nThe earlier trend was steady.\n\nThe summary is recorded.\n\nThe next result follows below.'
      ),
      message('ask', 'user', 'Summarize the result.'),
      message(
        'reply',
        'assistant',
        visual
          ? 'The trend is increasing.\n\n::orca-visual{file="trend.html"}'
          : 'The trend is increasing.'
      )
    ]
  }
  const theme = document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  return (
    <NativeChatVisualOwnerContext.Provider value={owner}>
      <div
        className={`${NATIVE_CHAT_APPEARANCE_ROOT_CLASS} flex h-[400px] flex-col`}
        style={nativeChatAppearanceStyle({ theme })}
      >
        <NativeChatMessageList session={session} isWorking={false} expandSignal={false} />
        <div className="border-t border-border p-3 text-xs text-muted-foreground">
          Composer boundary
        </div>
      </div>
    </NativeChatVisualOwnerContext.Provider>
  )
}

function visualSetup(): void {
  const call = window.api.runtime.call
  window.api.runtime.call = async (request) =>
    request.method === 'agentSession.readVisual'
      ? {
          id: 'reply-gap',
          ok: true,
          _meta: { runtimeId: 'fixture' },
          result: {
            ok: true,
            revision: '1',
            path: '/workspace/trend.html',
            html: '<div style="height:72px;background:var(--accent);color:var(--foreground);padding:16px;box-sizing:border-box">Trend: 12 → 18 → 25</div>'
          }
        }
      : call(request)
}

export const textEnding = defineFixture({ width: 560, render: () => <ReplyGap visual={false} /> })
export const visualEnding = defineFixture({
  width: 560,
  setup: visualSetup,
  render: () => <ReplyGap visual />
})
