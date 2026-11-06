// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageRow, type MessageRowProps } from './NativeChatMessageRow'
import type { NativeChatForkRowAction } from './use-native-chat-fork'

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))

afterEach(cleanup)

function forkAction(overrides: Partial<NativeChatForkRowAction> = {}): NativeChatForkRowAction {
  return {
    support: { kind: 'known', fork: 'checkpoint' },
    pending: false,
    request: vi.fn(),
    ...overrides
  }
}

function renderReply(props: Partial<MessageRowProps>): HTMLElement {
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
      {...props}
    />
  )
  return container.querySelector<HTMLElement>('.group')!
}

const forkButton = () => screen.getByRole('button', { name: 'Fork from this response' })

it('draws Fork in the response hover row right after Copy, and forks that response', () => {
  const fork = forkAction()
  renderReply({ fork })
  const copy = screen.getByRole('button', { name: 'Copy message' })

  expect(copy.parentElement).toBe(forkButton().parentElement)
  expect(copy.nextElementSibling).toBe(forkButton())
  fireEvent.click(forkButton())
  expect(fork.request).toHaveBeenCalledWith('reply')
})

it('keeps the hover row the same whether Fork is still being checked or ready', () => {
  const shape = (row: HTMLElement) => {
    const controls = forkButton().parentElement!
    return { lines: row.children.length, buttons: controls.querySelectorAll('button').length }
  }
  const checking = shape(renderReply({ fork: forkAction({ support: { kind: 'unknown' } }) }))
  expect(forkButton()).toHaveAttribute('aria-disabled', 'true')
  cleanup()
  const ready = shape(renderReply({ fork: forkAction() }))
  expect(forkButton()).toHaveAttribute('aria-disabled', 'false')

  expect(ready).toEqual(checking)
})

it('offers no Fork on a response the turn continues past, which has no hover row', () => {
  renderReply({ fork: forkAction(), continuesTurn: true })
  expect(screen.queryByRole('button', { name: 'Fork from this response' })).toBeNull()
})
