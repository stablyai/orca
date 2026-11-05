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

it('keeps a mid-turn fork inside its own response, adding no line before the next row', () => {
  const plain = Array.from(renderMidTurnReply(false).children)
  cleanup()
  const row = renderMidTurnReply(true)
  const button = screen.getByRole('button', { name: 'Fork from this response' })
  const holder = Array.from(row.children).find((child) => child.contains(button))

  // The same lines as the row without it: nothing below the response for the next row to meet.
  expect(row.children).toHaveLength(plain.length)
  // It sits beside the response's own words, within the box the next row follows.
  expect(holder?.textContent).toContain('Looking at the config next.')
  expect(row.lastElementChild).toBe(holder)
})
