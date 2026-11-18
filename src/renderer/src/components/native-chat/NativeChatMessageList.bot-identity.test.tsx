// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { render } from './messages/actions/native-chat-tooltip-test-harness'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatLiveSession } from './session/terminal/read/native-chat-live-session-contract'

const bot = {
  name: 'Atlas',
  src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X2/0AAAAASUVORK5CYII=',
  fallback: '🤖'
}
const session: NativeChatLiveSession = {
  messages: [
    {
      id: 'prompt',
      role: 'user',
      blocks: [{ type: 'text', text: 'Check the build' }],
      timestamp: 1,
      source: 'transcript'
    },
    {
      id: 'reasoning',
      role: 'reasoning',
      blocks: [{ type: 'text', text: 'Inspecting the build results.' }],
      timestamp: 2,
      source: 'transcript'
    },
    {
      id: 'answer',
      role: 'assistant',
      blocks: [{ type: 'text', text: 'The build passes.' }],
      timestamp: 2,
      source: 'transcript'
    }
  ],
  status: 'ready',
  sessionId: 'home',
  agent: 'codex',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: vi.fn(),
  readPhase: 'ready'
}
// A measurable viewport that holds every fixture row, so the list renders them all.
function installNativeChatMessageListTestViewport(): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.hasAttribute('data-native-chat-scroll')) {
        return 1_000_000
      }
      if (this.dataset.index !== undefined) {
        return 48
      }
      return original?.get?.call(this) ?? 0
    }
  })
  return () => {
    if (original) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', original)
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight')
    }
  }
}

let restoreViewport = () => {}
beforeAll(() => {
  restoreViewport = installNativeChatMessageListTestViewport()
})
afterAll(() => restoreViewport())
afterEach(cleanup)

it('keeps one avatar in the same turn bar through streaming, settlement and disclosure, and clears it on worker navigation', () => {
  const list = (working: boolean, turnBot: typeof bot | null = bot) => (
    <NativeChatMessageList
      session={session}
      isWorking={working}
      expandSignal={false}
      workingStartedAt={1}
      settledTurns={working ? undefined : new Map([['prompt', { startedAt: 1, workedSeconds: 5 }]])}
      turnBot={turnBot}
    />
  )
  const { container, rerender } = render(list(true))
  const avatar = screen.getByRole('img', { name: 'Atlas' })
  expect(avatar.closest('[data-native-chat-turn-status]')).toHaveAttribute(
    'data-native-chat-turn-status',
    'active'
  )
  expect(container).not.toHaveTextContent('Atlas')
  expect(avatar.querySelector('img')).toHaveAttribute('src', bot.src)
  rerender(list(true))
  expect(screen.getAllByRole('img', { name: 'Atlas' })).toHaveLength(1)
  rerender(list(false))
  expect(screen.getAllByRole('img', { name: 'Atlas' })).toHaveLength(1)
  expect(screen.getByRole('img', { name: 'Atlas' }).querySelector('img')).toHaveAttribute(
    'src',
    bot.src
  )
  expect(container.querySelector('[data-native-chat-turn-status]')).not.toHaveTextContent(
    bot.fallback
  )
  const disclosure = screen.getByRole('button', { name: /Atlas, Worked for 5s/ })
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(disclosure)
  expect(disclosure).toHaveAttribute('aria-expanded', 'true')
  rerender(list(false, null))
  expect(screen.queryByRole('img', { name: 'Atlas' })).toBeNull()
  expect(screen.getByText('Worked for 5s')).toBeInTheDocument()
})
