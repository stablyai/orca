import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

const STARTED_AT = Date.UTC(2026, 10, 20, 15, 0)
const PROMPTS = [
  'Make the rail calmer when the chat is long',
  'Why does the sidebar flicker on resize?',
  'Add a test for the parser round trip',
  'Rename the worker dock to something clearer',
  'Check the build on Windows before lunch',
  'Can you explain how paging older history works in the transcript window and where the rail fits?',
  'Fix the typo in the settings page',
  'Draft release notes for the bots page'
]

function chat(count: number): NativeChatMessage[] {
  const rows: NativeChatMessage[] = []
  for (let index = 0; index < count; index += 1) {
    const at = STARTED_AT + index * 7 * 60_000
    rows.push(
      {
        id: `u${index}`,
        role: 'user',
        source: 'transcript',
        timestamp: at,
        blocks: [{ type: 'text', text: `${PROMPTS[index % PROMPTS.length]} (${index + 1})` }]
      },
      {
        id: `a${index}`,
        role: 'assistant',
        source: 'transcript',
        timestamp: at + 60_000,
        blocks: [{ type: 'text', text: 'Done. The change is in and the checks pass.' }]
      }
    )
  }
  return rows
}

function sessionOf(rows: NativeChatMessage[]): NativeChatLiveSession {
  return {
    messages: rows,
    agent: 'claude',
    sessionId: 'fixture',
    status: 'ready',
    readPhase: 'ready',
    hasMore: false,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: async () => 'applied'
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function hoverRail(frame: HTMLElement): Promise<void> {
  // Let the window measure and the rail mount before the pointer arrives.
  await pause(300)
  const rail = frame.querySelector('[data-native-chat-rail]')
  rail?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
  await pause(350)
}

async function filterFor(frame: HTMLElement, query: string): Promise<void> {
  await hoverRail(frame)
  const input = frame.querySelector<HTMLInputElement>('[data-native-chat-rail-panel] input')
  if (!input) {
    return
  }
  input.focus()
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, query)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await pause(150)
}

function Chat({ count, height = 640 }: { count: number; height?: number }): React.JSX.Element {
  return (
    <div className="flex flex-col" style={{ height }}>
      <NativeChatMessageList
        session={sessionOf(chat(count))}
        isWorking={false}
        expandSignal={false}
      />
    </div>
  )
}

export const longChatListOpen = defineFixture({
  width: 760,
  render: () => <Chat count={180} />,
  interact: hoverRail
})

export const longChatFiltering = defineFixture({
  width: 760,
  render: () => <Chat count={180} />,
  interact: (frame) => filterFor(frame, 'rail')
})

// The match sits far into a long prompt, so the row starts at it.
export const longChatStartAtMatch = defineFixture({
  width: 760,
  render: () => <Chat count={180} />,
  interact: (frame) => filterFor(frame, 'transcript window')
})

export const longChatNoMatch = defineFixture({
  width: 760,
  render: () => <Chat count={180} />,
  interact: (frame) => filterFor(frame, 'kubernetes')
})

export const shortChatRest = defineFixture({
  width: 760,
  render: () => <Chat count={12} />,
  interact: async () => {
    await pause(300)
  }
})

export const shortChatPreview = defineFixture({
  width: 760,
  render: () => <Chat count={12} />,
  interact: async (frame) => {
    await pause(300)
    const tick = frame.querySelectorAll('[data-native-chat-rail-tick]')[5]
    tick?.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
    await pause(300)
  }
})

// Just over the rail's minimum pane width.
export const narrowPaneListOpen = defineFixture({
  width: 580,
  render: () => <Chat count={180} height={420} />,
  interact: hoverRail
})
