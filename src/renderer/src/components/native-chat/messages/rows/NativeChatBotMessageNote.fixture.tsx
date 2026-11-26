import { defineFixture } from '../../../../component-fixtures/component-fixture'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'
import { nativeChatAppearanceStyle } from '../../appearance/native-chat-appearance-style'
import { useState } from 'react'
import { NativeChatToolRunWindowProvider } from '../../tools/runs/native-chat-tool-run-window-context'

const message: NativeChatMessage = {
  id: 'research-note',
  role: 'user',
  source: 'transcript',
  timestamp: Date.UTC(2026, 10, 26, 12),
  blocks: [
    {
      type: 'text',
      text: 'The forecast is clear. I checked the hourly outlook and there is no rain expected this afternoon.'
    }
  ],
  from: {
    kind: 'agent',
    senders: [
      {
        name: 'Research bot',
        bot: true,
        party: { address: 'term_research', terminalHandle: 'term_research', orcaSessionId: null }
      }
    ],
    orchestration: { message: 'mail-notice', mailbox: 'term_scout', dispatchId: null, messages: [] }
  }
}
function Received() {
  return (
    <div
      className="native-chat-appearance bg-chat-canvas p-4"
      style={nativeChatAppearanceStyle({
        theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light'
      })}
    >
      <MessageRow
        messaging
        message={message}
        expandSignal={false}
        onScrollMessageToTop={() => {}}
      />
    </div>
  )
}
export const received = defineFixture({ width: 640, render: () => <Received /> })
export const receivedOpen = defineFixture({
  width: 640,
  render: () => <Received />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')?.click()
  }
})

function FindReceived() {
  const [query, setQuery] = useState('')
  return (
    <NativeChatToolRunWindowProvider isVisible find={{ isOpen: true, query }}>
      <button type="button" onClick={() => setQuery(query ? '' : 'hourly outlook')}>
        Toggle Find
      </button>
      <Received />
    </NativeChatToolRunWindowProvider>
  )
}
export const receivedFind = defineFixture({ width: 640, render: () => <FindReceived /> })
