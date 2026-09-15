// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { WORKSPACE_FILE_PATH_MIME } from '@/lib/workspace-file-drag'
import NativeChatView from './NativeChatView'
import { useNativeChatPaneFileDropClaim } from './NativeChatPaneFileDropSurface'

const drop = vi.hoisted(() => ({ onDrop: vi.fn() }))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

vi.mock('./NativeChatSessionGate', () => ({ NativeChatSessionGate: () => null }))

vi.mock('./NativeChatResolvedView', () => ({ NativeChatResolvedView: () => null }))

vi.mock('./use-native-chat-status-entry', () => ({ useNativeChatStatusEntry: vi.fn() }))

vi.mock('./NativeChatStructuredSession', () => ({
  NativeChatStructuredSession: () => {
    useNativeChatPaneFileDropClaim({
      scopeKey: 'structured:session',
      disabled: false,
      onDragOverCapture: (event) => event.preventDefault(),
      onDropCapture: drop.onDrop
    })

    return <div data-testid="transcript">Conversation above the composer</div>
  }
}))

afterEach(cleanup)

it('owns pane drops for standalone structured sessions without a terminal portal', () => {
  const { container } = render(
    <NativeChatView
      mode="structured"
      tabId="structured-tab"
      sessionId="session"
      agent="codex"
      target={{ kind: 'local' }}
      isVisible
      isFocusedGroup
    />
  )

  const transcript = screen.getByTestId('transcript')
  const dataTransfer = { types: [WORKSPACE_FILE_PATH_MIME] }

  fireEvent.dragOver(transcript, { dataTransfer })
  expect(container.querySelector('[data-native-chat-drop-overlay]')).not.toBeNull()
  expect(
    transcript
      .closest('[data-native-file-drop-target="composer"]')
      ?.getAttribute('data-composer-scope-key')
  ).toBe('structured:session')

  fireEvent.drop(transcript, { dataTransfer })
  expect(drop.onDrop).toHaveBeenCalledTimes(1)
  expect(container.querySelector('[data-native-chat-drop-overlay]')).toBeNull()
})
