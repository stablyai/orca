// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { BotMemoryHistoryView } from '../../../../../shared/bots/bot-memory-history'
import { BotMemoryHistory } from './BotMemoryHistory'

afterEach(cleanup)

const row = (id: string, by: BotMemoryHistoryView['by']): BotMemoryHistoryView => ({
  id,
  at: Date.UTC(2026, 10, 6, 9),
  by,
  change: { added: [], removed: [{ line: '- 2026-11-01 owner fact', after: '# Memory' }] },
  undoable: true,
  chat: null
})

it('shows the Undo it made even when the file reads back byte for byte the same', async () => {
  const tidied = row('t1', { kind: 'tidy-up' })
  let rows = [tidied]
  const undo = async (): Promise<boolean> => {
    // A chat had already put the fact back: the Undo writes only its row.
    rows = [
      { ...row('u1', { kind: 'undo', of: 't1' }), change: { added: [], removed: [] } },
      tidied
    ]
    return true
  }
  const { container } = render(
    <BotMemoryHistory
      load={async () => rows}
      undo={undo}
      version="the same bytes"
      onChanged={async () => {}}
    />
  )
  fireEvent.click(await screen.findByRole('button', { expanded: false }))
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))

  // The open list reads History again: the Undo's row joins the one it undid.
  await waitFor(() => expect(container.querySelectorAll('[aria-expanded]')).toHaveLength(2))
})
