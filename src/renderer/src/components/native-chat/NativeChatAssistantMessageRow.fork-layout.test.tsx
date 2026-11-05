// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageRow } from './NativeChatMessageRow'
import type { NativeChatForkSurface } from './use-native-chat-fork'

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))

afterEach(cleanup)

const fork: NativeChatForkSurface = {
  support: { kind: 'known', fork: 'checkpoint' },
  contextFloorSequence: 0,
  forkableItemIds: new Set(['reply']),
  pending: false,
  request: vi.fn()
}

function renderMidTurnReply(withFork: boolean): HTMLElement {
  const { container } = render(
    <MessageRow
      message={{
        id: 'reply',
        role: 'assistant',
        timestamp: 0,
        source: 'transcript',
        blocks: [{ type: 'text', text: 'Looking at the config next.' }]
      }}
      expandSignal={false}
      onScrollMessageToTop={vi.fn()}
      continuesTurn
      {...(withFork ? { fork } : {})}
    />
  )
  return container.querySelector<HTMLElement>('.group')!
}

it('adds no line of its own to a mid-turn response beside the row without it', () => {
  const plain = Array.from(renderMidTurnReply(false).children)
  cleanup()
  const row = renderMidTurnReply(true)
  const button = screen.getByRole('button', { name: 'Fork from this response' })
  const added = Array.from(row.children).filter((child) => child.contains(button))

  expect(row.children).toHaveLength(plain.length + 1)
  expect(added).toHaveLength(1)
  expect(getComputedStyle(added[0]!).height).toBe('0px')
})
