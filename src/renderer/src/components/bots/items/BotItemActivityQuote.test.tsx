// @vitest-environment happy-dom

import { useRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import {
  NativeChatSelectionQuote,
  type NativeChatQuoteTarget
} from '../../native-chat/selection-quotes/NativeChatSelectionQuote'
import { BotItemActivityList } from './BotItemActivityList'

const COMMENT = 'Approve the first two; hold the rest.'
const events: BotItemEvent[] = [
  {
    id: 'e1',
    kind: 'commented',
    actor: { kind: 'owner' },
    data: { text: `${COMMENT}\nThen rebase.` },
    at: 0
  }
]

afterEach(() => {
  vi.useRealTimers()
  window.getSelection()?.removeAllRanges()
  cleanup()
})

function ItemPage({ box }: { box: NativeChatQuoteTarget }): React.JSX.Element {
  const root = useRef<HTMLDivElement | null>(null)
  const boxRef = useRef(box)
  return (
    <TooltipProvider>
      <div ref={root}>
        <p>Item title outside the activity</p>
        <BotItemActivityList bot={fixtureCos} item={makeTestBotItem(1)} events={events} />
        <NativeChatSelectionQuote rootRef={root} composerRef={boxRef} enabled />
      </div>
    </TooltipProvider>
  )
}

function selectText(text: string): void {
  const node = screen.getByText(text, { exact: false })
  const range = document.createRange()
  range.selectNodeContents(node)
  const selection = window.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
  act(() => {
    document.dispatchEvent(new Event('selectionchange'))
    fireEvent.mouseUp(window, { button: 0, detail: 1, clientX: 10, clientY: 10 })
  })
}

it('adds a selection in item activity to the comment box as a chat quote', async () => {
  const added: string[] = []
  render(<ItemPage box={{ acceptsText: () => true, insertQuote: (quote) => added.push(quote) }} />)
  selectText(COMMENT)
  fireEvent.click(await screen.findByRole('button', { name: 'Add to chat' }))
  expect(added).toEqual([`> ${COMMENT}\n> Then rebase.\n\n`])
})

it('offers nothing for text outside the activity', () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  render(<ItemPage box={{ acceptsText: () => true, insertQuote: () => {} }} />)
  selectText('Item title outside the activity')
  act(() => vi.runAllTimers())
  expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
})
