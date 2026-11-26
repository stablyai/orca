// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import * as blocks from '../../../comment-markdown/markdown-top-level-blocks'
import { NativeChatDisclosureContext } from '../disclosure/native-chat-disclosure-store'
import { NativeChatReasoningRow } from './NativeChatReasoningRow'

vi.mock('../../../comment-markdown/markdown-top-level-blocks', { spy: true })

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const store = { read: () => true, write: () => {}, toolRunMeasurements: new Map() }

// Perf contract: an expanded thought that streams parses only its new tail each live window,
// never its whole text again.
it('splits an expanded streaming thought from its previous split', () => {
  vi.useFakeTimers({
    toFake: [
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'performance',
      'setTimeout',
      'clearTimeout'
    ]
  })
  const split = vi.mocked(blocks.splitMarkdownTopLevelBlocks)
  const paragraph = (index: number) => `Step ${index} of the thought, with some words.\n\n`
  let markdown = paragraph(0)
  const row = (text: string) => (
    <NativeChatDisclosureContext.Provider value={store}>
      <NativeChatReasoningRow
        message={{
          id: 'thought',
          role: 'reasoning',
          state: 'running',
          timestamp: 1,
          journalRevision: 1
        }}
        markdown={text}
        turnIsWorking
      />
    </NativeChatDisclosureContext.Provider>
  )
  const view = render(row(markdown))
  for (let window = 1; window <= 20; window++) {
    markdown += paragraph(window)
    view.rerender(row(markdown))
    act(() => {
      vi.advanceTimersByTime(20)
    })
  }
  const calls = split.mock.calls
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.filter(([, previous]) => previous === null).length).toBeLessThanOrEqual(1)
})
