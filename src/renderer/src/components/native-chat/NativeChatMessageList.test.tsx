// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/sidebar/CommentMarkdown', () => ({
  default: ({ content }: { content: string }) => <div data-comment-markdown="">{content}</div>
}))

beforeAll(() => {
  ;(
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ui: { writeClipboardText: vi.fn() } }
  })
})

function sessionWithMessages(messages: NativeChatMessage[]): NativeChatLiveSession {
  return {
    sessionId: 'session-1',
    agent: 'codex',
    status: 'ready',
    messages,
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn()
  }
}

function sessionWithUserText(text: string): NativeChatLiveSession {
  return sessionWithMessages([
    {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: 1,
      source: 'transcript'
    }
  ])
}

async function renderList(session: NativeChatLiveSession): Promise<{
  container: HTMLDivElement
  root: Root
}> {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <NativeChatMessageList
        session={session}
        isWorking={false}
        expandSignal={false}
        fontScale={1}
      />
    )
  })
  return { container, root }
}

function buttonWithText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((entry) =>
    entry.textContent?.includes(text)
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Missing button: ${text}`)
  }
  return button
}

describe('NativeChatMessageList', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('collapses and expands long user messages locally', async () => {
    const { container, root } = await renderList(sessionWithUserText('x'.repeat(601)))

    expect(container.textContent).toContain('Show full message')
    expect(buttonWithText(container, 'Show full message').getAttribute('aria-expanded')).toBe(
      'false'
    )

    await act(async () => {
      buttonWithText(container, 'Show full message').dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      )
    })

    expect(container.textContent).toContain('Show less')
    expect(buttonWithText(container, 'Show less').getAttribute('aria-expanded')).toBe('true')
    act(() => root.unmount())
  })

  it('renders metadata timestamps only when messages provide real timestamps', async () => {
    const timestamp = Date.UTC(2026, 0, 2, 15, 4)
    const expectedTime = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(timestamp))
    const nullTimestampTime = new Intl.DateTimeFormat(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    }).format(new Date(Date.UTC(2026, 0, 2, 16, 4)))

    const { container, root } = await renderList(
      sessionWithMessages([
        {
          id: 'assistant-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Timed assistant reply' }],
          timestamp,
          source: 'transcript'
        },
        {
          id: 'assistant-2',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Untimed assistant reply' }],
          timestamp: null,
          source: 'transcript'
        }
      ])
    )

    expect(container.textContent).toContain(expectedTime)
    expect(container.textContent).not.toContain(nullTimestampTime)
    act(() => root.unmount())
  })
})
