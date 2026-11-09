import { useState } from 'react'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import { NativeChatEmptyState } from '../../host-access/NativeChatEmptyState'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { NativeChatPaneHeader } from './NativeChatPaneHeader'

export const splitShortcut = defineFixture({
  width: 420,
  render: () => (
    <div className="relative bg-background p-6 pb-20">
      <NativeChatPaneHeader
        tabId="fixture-chat"
        worktreeId="fixture-workspace"
        groupId="fixture-group"
        nativeChat={{ sessionId: 'fixture-session', agent: undefined }}
        focused
        colorScheme={undefined}
      />
    </div>
  ),
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Split Chat Right"]')?.focus()
  }
})

export const settings = defineFixture({
  ...splitShortcut,
  interact: (frame) => {
    frame
      .querySelector<HTMLButtonElement>('button[aria-label="Chat settings"]')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  }
})

const toolbarStore = {
  folderWorkspaces: [makeFolderWorkspace({ id: 'checkout', folderPath: '/projects/acme/app' })]
}
const firstMessage =
  'Review every part of the checkout flow before implementation starts. The shipping address, payment method, order summary, confirmation step and retry path must remain readable in a narrow pane. Keep the first line visible when the conversation is at the top, including while the toolbar is active. The owner should be able to read this entire report without changing focus or moving the pointer away.'

function toolbarMessage(index: number): NativeChatMessage {
  return {
    id: `checkout-message-${index}`,
    role: 'assistant',
    source: 'transcript',
    timestamp: index,
    blocks: [
      {
        type: 'text',
        text:
          index === 0
            ? firstMessage
            : `Checkpoint ${index}: checkout validation completed. The next review can continue without changing the current owner decisions.`
      }
    ]
  }
}

function ToolbarTranscript({
  focused = true,
  history = false,
  empty = false,
  older = false,
  header = true
}: {
  focused?: boolean
  history?: boolean
  empty?: boolean
  older?: boolean
  header?: boolean
}) {
  const [extra, setExtra] = useState(0)
  const session: NativeChatLiveSession = {
    messages: Array.from({ length: (history ? 80 : 2) + extra }, (_, index) =>
      toolbarMessage(index)
    ),
    agent: 'codex',
    sessionId: 'codex-checkout',
    status: 'ready',
    readPhase: 'ready',
    hasMore: older,
    loadingEarlier: false,
    olderHistoryGeneration: 0,
    loadEarlier: async () => 'unchanged'
  }
  return (
    <div
      data-native-chat-root="true"
      className="native-chat-appearance relative flex h-[480px] min-h-0 flex-col overflow-hidden bg-chat-pane text-chat-foreground"
    >
      {header ? (
        <NativeChatPaneHeader
          tabId="checkout-chat"
          worktreeId="folder:checkout"
          groupId="checkout-group"
          nativeChat={{ sessionId: 'codex-checkout', agent: 'codex' }}
          focused={focused}
          colorScheme={undefined}
          handOff={{ open: () => {}, disabled: false }}
        />
      ) : null}
      {empty ? (
        <NativeChatEmptyState kind="empty" agent="codex" />
      ) : (
        <NativeChatMessageList session={session} isWorking={false} expandSignal={false} />
      )}
      {history ? (
        <button type="button" className="sr-only" onClick={() => setExtra((value) => value + 1)}>
          Append reply
        </button>
      ) : null}
    </div>
  )
}

function assertPaneActionSizes(frame: HTMLElement, expectedCount: number): void {
  const buttons = frame.querySelectorAll('.native-chat-pane-actions > button')
  if (buttons.length !== expectedCount) {
    throw new Error(`Expected ${expectedCount} pane actions`)
  }
  for (const button of buttons) {
    const bounds = button.getBoundingClientRect()
    const icon = button.querySelector('svg')?.getBoundingClientRect()
    if (bounds.width !== 28 || bounds.height !== 28 || icon?.width !== 16 || icon.height !== 16) {
      throw new Error('Pane actions must use 28px targets and 16px icons')
    }
  }
}

export const toolbarWide = defineFixture({
  width: 800,
  store: toolbarStore,
  render: () => <ToolbarTranscript />,
  interact: (frame) => assertPaneActionSizes(frame, 4)
})
export const toolbarNarrow = defineFixture({
  ...toolbarWide,
  width: 390
})
export const toolbarInactive = defineFixture({
  ...toolbarWide,
  render: () => <ToolbarTranscript focused={false} />,
  interact: (frame) => assertPaneActionSizes(frame, 3)
})
export const toolbarEmpty = defineFixture({
  ...toolbarNarrow,
  render: () => <ToolbarTranscript empty />
})
export const toolbarHistory = defineFixture({
  ...toolbarNarrow,
  render: () => <ToolbarTranscript history />
})
export const transcriptWithoutToolbar = defineFixture({
  ...toolbarNarrow,
  render: () => <ToolbarTranscript header={false} />,
  interact: (frame) => assertPaneActionSizes(frame, 0)
})

export const toolbarOlderHistory = defineFixture({
  ...toolbarNarrow,
  render: () => <ToolbarTranscript older />
})
