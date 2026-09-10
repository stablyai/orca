// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { forwardRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatStructuredSession } from './NativeChatStructuredSession'

const mocks = vi.hoisted(() => ({
  epoch: 'epoch-1',
  composerProps: null as { paneKey: string } | null
}))
vi.mock('./use-structured-agent-session', () => ({
  useStructuredAgentSession: () => ({
    epoch: mocks.epoch,
    messages: [{ id: 'message', role: 'user', blocks: [{ type: 'text', text: 'Prompt' }] }],
    status: 'ready',
    isWorking: false,
    prompts: [],
    outbox: [],
    rewind: { pending: false, disabledReason: null, request: vi.fn() }
  })
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => vi.fn()
}))
vi.mock('./use-native-chat-font-scale', () => ({ useNativeChatFontScale: () => ({ scale: 1 }) }))
vi.mock('./use-native-chat-file-link-context', () => ({ useNativeChatFileLinkContext: () => null }))
vi.mock('./native-chat-image-runtime-context', () => ({
  useNativeChatImageRuntimeContext: () => null
}))
vi.mock('./use-native-chat-link-actions', () => ({
  useNativeChatLinkActions: () => ({
    onLinkClick: vi.fn(),
    linkActionRequest: null,
    closeLinkActions: vi.fn()
  })
}))
vi.mock('./use-structured-native-chat-pane-commands', () => ({
  useStructuredNativeChatPaneCommands: () => ({ menu: null })
}))
vi.mock('./NativeChatMessageList', () => ({
  NativeChatMessageList: () => <div data-testid="message-list" />
}))
vi.mock('./NativeChatComposer', async () => {
  const { useNativeChatDraft } = await import('./use-native-chat-draft')
  return {
    NativeChatComposer: forwardRef((_props: { paneKey: string }, _ref) => {
      mocks.composerProps = _props
      const { draft, setDraft } = useNativeChatDraft(_props.paneKey)
      return (
        <textarea
          data-testid="structured-composer"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
      )
    })
  }
})
afterEach(cleanup)
it('clears cached draft and remounts transcript on epoch change, preserving same-epoch refreshes', () => {
  const props = {
    isVisible: true,
    tabId: 'epoch-tab',
    sessionId: 'epoch-session',
    target: { kind: 'local' as const },
    agent: 'codex' as const
  }
  const view = render(<NativeChatStructuredSession {...props} />)
  const composer = screen.getByTestId('structured-composer') as HTMLTextAreaElement
  const transcript = screen.getByTestId('message-list')
  const oldScope = mocks.composerProps!.paneKey
  fireEvent.change(composer, { target: { value: 'stale unsent draft' } })
  view.rerender(<NativeChatStructuredSession {...props} />)
  expect(screen.getByTestId('structured-composer')).toBe(composer)
  expect(composer.value).toBe('stale unsent draft')
  mocks.epoch = 'epoch-2'
  view.rerender(<NativeChatStructuredSession {...props} />)
  expect(screen.getByTestId('message-list')).not.toBe(transcript)
  expect(screen.getByTestId('structured-composer')).not.toBe(composer)
  expect((screen.getByTestId('structured-composer') as HTMLTextAreaElement).value).toBe('')
  expect(mocks.composerProps!.paneKey).not.toBe(oldScope)
  view.unmount()
  render(<NativeChatStructuredSession {...props} />)
  expect((screen.getByTestId('structured-composer') as HTMLTextAreaElement).value).toBe('')
})
