// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { BotItem, BotItemStatus } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { useBotItemStatusNotes } from './BotItemStatusNoteDialog'

afterEach(cleanup)

function Harness({
  onMove,
  expose
}: {
  onMove: (items: readonly BotItem[], to: BotItemStatus, note?: string) => void
  expose: (move: (items: readonly BotItem[], to: BotItemStatus) => void) => void
}): React.JSX.Element {
  const notes = useBotItemStatusNotes(onMove)
  expose(notes.move)
  return notes.dialog
}

it('cancels at once with no reason, while Waiting still asks what it waits on', () => {
  const onMove = vi.fn()
  let move: (items: readonly BotItem[], to: BotItemStatus) => void = () => {}
  render(<Harness onMove={onMove} expose={(m) => (move = m)} />)
  const item = makeTestBotItem(1, { title: 'Ship it' })

  act(() => move([item], 'canceled'))
  expect(onMove).toHaveBeenCalledExactlyOnceWith([item], 'canceled')
  expect(screen.queryByRole('dialog')).toBeNull()

  act(() => move([item], 'waiting'))
  expect(onMove).toHaveBeenCalledOnce()
  expect(screen.getByRole('dialog').textContent).toContain('What is Ship it waiting on?')
})
