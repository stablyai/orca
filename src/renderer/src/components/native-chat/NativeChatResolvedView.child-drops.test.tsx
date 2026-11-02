// @vitest-environment happy-dom
import { useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { TooltipProvider } from '@/components/ui/tooltip'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import { NativeChatResolvedView } from './NativeChatResolvedView'
import {
  NativeChatPaneFileDropSurface,
  useNativeChatPaneFileDropClaim
} from './NativeChatPaneFileDropSurface'
import { useNativeChatChildNavigation } from './native-chat-child-navigation'
import type { NativeChatLiveSession } from './native-chat-live-session-contract'

vi.mock('./use-native-chat-retained-session', () => ({
  useNativeChatRetainedSession: () => ({
    agent: 'codex',
    sessionId: 'terminal-parent',
    status: 'ready',
    readPhase: 'ready',
    messages: [
      {
        id: 'child',
        role: 'assistant',
        timestamp: 1,
        source: 'transcript',
        agentId: 'child',
        blocks: [{ type: 'text', text: 'Child answer' }]
      }
    ],
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: async () => 'exhausted'
  })
}))
vi.mock('./NativeChatComposer', () => ({
  NativeChatComposer: () => {
    const [draft, setDraft] = useState('Parent draft')
    useNativeChatPaneFileDropClaim({
      destinationKey: 'parent',
      disabled: false,
      captureExternalDrop: () => async () => {},
      onDragOverCapture: (event) => event.preventDefault(),
      onDropCapture: () => setDraft((value) => `${value} ATTACHED`)
    })
    return <textarea aria-label="Parent draft" readOnly value={draft} />
  }
}))
vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: ({ session }: { session: NativeChatLiveSession }) => {
    const navigation = useNativeChatChildNavigation()
    return (
      <div data-testid={`feed:${session.sessionId}`}>
        <button onClick={() => navigation?.open({ agentId: 'child', label: 'Child' })}>
          Inspect child
        </button>
      </div>
    )
  }
}))
const initial = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  useAppStore.setState(initial, true)
})
it('keeps terminal-backed parent drafts unchanged by child drops and restores attachment routing on Back', async () => {
  useAppStore.setState(initial, true)
  render(
    <TooltipProvider>
      <NativeChatPaneFileDropSurface className="pane">
        <NativeChatResolvedView
          paneKey="tab:leaf"
          terminalTabId="tab"
          sessionId="terminal-parent"
          agent="codex"
          transcriptPath={null}
          isVisible
          isFocusedGroup
          targetPtyId={null}
          ownsTabWideLaunchDraft={false}
        />
      </NativeChatPaneFileDropSurface>
    </TooltipProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Inspect child' }))
  const feed = await screen.findByTestId('feed:terminal-parent:child:child')
  const dataTransfer = { types: [WORKSPACE_FILE_PATH_MIME] }
  fireEvent.dragOver(feed, { dataTransfer })
  fireEvent.drop(feed, { dataTransfer })
  const draft = screen.getByLabelText<HTMLTextAreaElement>('Parent draft')
  expect(draft.value).toBe('Parent draft')
  fireEvent.click(screen.getByRole('button', { name: 'Back to conversation' }))
  fireEvent.drop(screen.getByTestId('feed:terminal-parent'), { dataTransfer })
  expect(draft.value).toBe('Parent draft ATTACHED')
})
