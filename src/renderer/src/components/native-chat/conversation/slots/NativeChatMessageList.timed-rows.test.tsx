// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { render } from '../../messages/actions/native-chat-tooltip-test-harness'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import {
  layout,
  marker,
  session,
  stubLayout,
  stubResizeObserver
} from '../../viewport/virtualization/native-chat-windowing-test-harness'

// Pacing is not this test's subject.
vi.mock('../../markdown/use-native-chat-paced-text', async (importOriginal) =>
  (await import('../../markdown/native-chat-unpaced-text-fixture')).unpacedTextModule(
    importOriginal
  )
)

let restore: (() => void)[] = []
beforeEach(() => {
  restore = [stubLayout({ scrollGeometry: true, offsetChain: true }), stubResizeObserver()]
})
afterEach(() => {
  cleanup()
  for (const undo of restore.toReversed()) {
    undo()
  }
  layout.measuredRowHeights = []
})

it('draws a worker approval at its own time, with newer replies after it', () => {
  // marker(i) is message `marker-i`, at time i + 1.
  const messages = [0, 1, 2, 3].map(marker)
  render(
    <NativeChatMessageList
      session={session(messages)}
      isWorking={false}
      expandSignal={false}
      timedRows={[
        { key: 'open', at: 3.5, node: <p>Allow Bash? (open)</p> },
        { key: 'receipt', at: 1.5, node: <p>Allowed by you 3:11 PM</p> }
      ]}
    />
  )

  const order = [
    'marker-0',
    'Allowed by you 3:11 PM',
    'marker-1',
    'marker-2',
    'Allow Bash? (open)',
    'marker-3'
  ].map((text) => screen.getByText(text))
  for (const [index, element] of order.slice(1).entries()) {
    expect(order[index].compareDocumentPosition(element)).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  }
})
