// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import { deriveNativeChatRowContent } from '../../../../../../shared/native-chat/transcript/row-content/native-chat-row-content'
import { NativeChatAssistantMessageRow } from './NativeChatAssistantMessageRow'

vi.mock('../../markdown/NativeChatPacedMarkdown', () => ({
  NativeChatPacedMarkdown: ({ content }: { content: string }) => <div>{content}</div>
}))

vi.mock('../../../bots/bot-workspace', () => ({
  useBotForWorkspace: () => null
}))

vi.mock('../../media/visuals/native-chat-visual-owner', () => ({
  useNativeChatVisualOwner: () => null
}))

const sampleReply: NativeChatMessage = {
  id: 'reply-42',
  role: 'assistant',
  source: 'transcript',
  timestamp: 1_700_000_000_000,
  blocks: [{ type: 'text', text: 'Here is the plan.' }]
}

describe('NativeChatAssistantMessageRow hand-off action', () => {
  afterEach(() => {
    cleanup()
  })
  it('renders Hand off from this response when native Fork is absent', () => {
    const openFromResponse = vi.fn()
    render(
      <TooltipProvider>
        <NativeChatAssistantMessageRow
          props={{
            message: sampleReply,
            expandSignal: false,
            endsResponse: true,
            latestResponse: true,
            onScrollMessageToTop: vi.fn(),
            handOff: { openFromResponse }
          }}
          content={deriveNativeChatRowContent(sampleReply.blocks)}
          run={undefined}
          rowRef={{ current: null }}
          scrollToTop={vi.fn()}
        />
      </TooltipProvider>
    )

    const button = screen.getByRole('button', { name: 'Hand off from this response' })
    fireEvent.click(button)
    expect(openFromResponse).toHaveBeenCalledWith('reply-42')
  })

  it('prefers native Fork and hides Hand off when both are provided', () => {
    render(
      <TooltipProvider>
        <NativeChatAssistantMessageRow
          props={{
            message: sampleReply,
            expandSignal: false,
            endsResponse: true,
            latestResponse: true,
            onScrollMessageToTop: vi.fn(),
            fork: {
              support: { kind: 'known', fork: 'checkpoint' },
              pendingItemId: null,
              request: vi.fn()
            },
            handOff: { openFromResponse: vi.fn() }
          }}
          content={deriveNativeChatRowContent(sampleReply.blocks)}
          run={undefined}
          rowRef={{ current: null }}
          scrollToTop={vi.fn()}
        />
      </TooltipProvider>
    )

    expect(screen.getByRole('button', { name: 'Fork from this response' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Hand off from this response' })).toBeNull()
  })
})
