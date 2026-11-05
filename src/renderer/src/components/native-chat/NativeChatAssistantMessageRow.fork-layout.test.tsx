// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, screen } from '@testing-library/react'
import { render } from './native-chat-tooltip-test-harness'
import { afterEach, expect, it, vi } from 'vitest'
import { MessageRow, type MessageRowProps } from './NativeChatMessageRow'
import { NativeChatForkGutterContext } from './native-chat-fork-context'
import type { NativeChatForkRowAction } from './use-native-chat-fork'

vi.mock('@/lib/syntax-highlighting/oniguruma', async () => ({
  loadOniguruma: (await import('@/lib/syntax-highlighting/oniguruma-test-harness'))
    .loadNodeOniguruma
}))

afterEach(cleanup)

const fork: NativeChatForkRowAction = {
  support: { kind: 'known', fork: 'checkpoint' },
  pending: false,
  request: vi.fn()
}

/** The chat's own reply in a pane that draws fork actions; `fork` is present only when offered. */
function renderReply(props: Partial<MessageRowProps>): HTMLElement {
  const { container } = render(
    <NativeChatForkGutterContext.Provider value>
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
    </NativeChatForkGutterContext.Provider>
  )
  return container.querySelector<HTMLElement>('.group')!
}

/** What sets the prose's width: the row's text box and whether a gutter sits beside it. */
function proseLayout(row: HTMLElement) {
  const prose = Array.from(row.children).find((child) =>
    child.textContent?.includes('Looking at the config next.')
  )
  return {
    lines: row.children.length,
    gutter: prose?.querySelector('[data-native-chat-fork-gutter]') !== null
  }
}

it('keeps a mid-turn fork inside its own response, adding no line before the next row', () => {
  const plain = proseLayout(renderReply({ continuesTurn: true }))
  cleanup()
  const row = renderReply({ continuesTurn: true, fork })
  const button = screen.getByRole('button', { name: 'Fork from this response' })
  const holder = Array.from(row.children).find((child) => child.contains(button))

  expect(proseLayout(row)).toEqual(plain)
  expect(holder?.textContent).toContain('Looking at the config next.')
  expect(row.lastElementChild).toBe(holder)
})

it('keeps the same prose width while the turn runs, once it finishes, and if forks prove unsupported', () => {
  const working = proseLayout(renderReply({ activeTurnIsWorking: true }))
  cleanup()
  const finished = proseLayout(renderReply({ fork }))
  // The turn-final controls hang below; the fork is only in the gutter.
  expect(screen.getAllByRole('button', { name: 'Fork from this response' })).toHaveLength(1)
  cleanup()
  const unsupported = proseLayout(renderReply({}))

  expect(working.gutter).toBe(true)
  expect(finished.gutter).toBe(true)
  expect(unsupported.gutter).toBe(true)
})

it('gives a subagent reply no gutter', () => {
  expect(proseLayout(renderReply({ inSubagentSection: true, fork })).gutter).toBe(false)
  expect(screen.queryByRole('button', { name: 'Fork from this response' })).toBeNull()
})
