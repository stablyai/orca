// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotItem, BotItemStatus } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { useBotItemStatusNotes } from './BotItemStatusNoteDialog'

afterEach(cleanup)

function Harness({
  item,
  onMove
}: {
  item: BotItem
  onMove: (items: readonly BotItem[], to: BotItemStatus, note?: string) => void
}): React.JSX.Element {
  const notes = useBotItemStatusNotes(onMove)
  return (
    <>
      <button onClick={() => notes.move([item], 'canceled')}>to-canceled</button>
      <button onClick={() => notes.move([item], 'waiting')}>to-waiting</button>
      {notes.dialog}
    </>
  )
}

it('cancels at once with no reason, while Waiting still asks what it waits on', () => {
  const onMove = vi.fn()
  const item = makeTestBotItem(1, { title: 'Ship it' })
  render(<Harness item={item} onMove={onMove} />)

  fireEvent.click(screen.getByText('to-canceled'))
  expect(onMove).toHaveBeenCalledExactlyOnceWith([item], 'canceled')
  expect(screen.queryByRole('dialog')).toBeNull()

  fireEvent.click(screen.getByText('to-waiting'))
  expect(onMove).toHaveBeenCalledOnce()
  expect(screen.getByRole('dialog').textContent).toContain('What is Ship it waiting on?')
})
