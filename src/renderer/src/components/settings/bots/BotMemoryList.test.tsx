// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { type BotMemoryEdits, BotMemoryList } from './BotMemoryList'
import { openAppHttpLink } from '@/lib/browser/navigation/app-http-link-open'

vi.mock('@/lib/browser/navigation/app-http-link-open', () => ({ openAppHttpLink: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

afterEach(cleanup)

const MEMORY =
  '# Memory\n\n- 2026-10-24 Dana wants blockers first.\n- 2026-10-25 Jane owns checkout.\n'

function edits(overrides: Partial<BotMemoryEdits> = {}): BotMemoryEdits {
  return {
    add: vi.fn(async () => {}),
    reword: vi.fn(async () => {}),
    forget: vi.fn(async () => {}),
    ...overrides
  }
}

const file = (disk: string) => ({ disk, refresh: vi.fn(async () => {}) })

describe('BotMemoryList', () => {
  it('rewords the fact the owner clicked by its words, even after the bot moved its line', async () => {
    const memory = edits()
    const { getByRole, rerender } = render(<BotMemoryList file={file(MEMORY)} edits={memory} />)
    fireEvent.click(getByRole('button', { name: 'Jane owns checkout.' }))
    const moved = MEMORY.replace('# Memory\n\n', '# Memory\n\n- 2026-10-27 New from the bot.\n')
    rerender(<BotMemoryList file={file(moved)} edits={memory} />)
    fireEvent.change(getByRole('textbox', { name: 'Memory' }), {
      target: { value: 'Jane owns checkout and billing.' }
    })
    fireEvent.click(getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(memory.reword).toHaveBeenCalledWith(
        'Jane owns checkout.',
        'Jane owns checkout and billing.'
      )
    )
  })

  it('keeps the draft open when the host refuses the change', async () => {
    const memory = edits({
      add: vi.fn(async () => {
        throw new Error('kept changing')
      })
    })
    const { getByRole } = render(<BotMemoryList file={file(MEMORY)} edits={memory} />)
    fireEvent.change(getByRole('textbox', { name: 'Add memory' }), { target: { value: 'A fact' } })
    fireEvent.click(getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(memory.add).toHaveBeenCalledWith('A fact'))
    expect(getByRole('textbox', { name: 'Add memory' })).toHaveProperty('value', 'A fact')
  })

  it('shows where a fact came from, and forgets it by its words', async () => {
    const tagged = `${MEMORY}- 2026-10-31 deploys at noon · from: Slack, Alice <https://app.slack.com/client/T1/C1>\n`
    const memory = edits()
    const { getByRole, getAllByRole, getByText } = render(
      <BotMemoryList file={file(tagged)} edits={memory} />
    )
    expect(getByText('From Slack, Alice', { exact: false })).toBeTruthy()
    fireEvent.click(getByRole('button', { name: 'From Slack, Alice' }))
    expect(openAppHttpLink).toHaveBeenCalledWith(
      'https://app.slack.com/client/T1/C1',
      expect.anything()
    )
    fireEvent.click(getAllByRole('button', { name: 'Forget' })[2])
    await waitFor(() => expect(memory.forget).toHaveBeenCalledWith('deploys at noon'))
  })

  it('saves an open draft when its screen closes, and nothing once it was cancelled', () => {
    const memory = edits()
    const added = render(<BotMemoryList file={file(MEMORY)} edits={memory} />)
    fireEvent.change(added.getByRole('textbox', { name: 'Add memory' }), {
      target: { value: 'Ships on Tuesdays' }
    })
    added.unmount()
    expect(memory.add).toHaveBeenCalledWith('Ships on Tuesdays')

    const reworded = render(<BotMemoryList file={file(MEMORY)} edits={memory} />)
    fireEvent.click(reworded.getByRole('button', { name: 'Jane owns checkout.' }))
    fireEvent.change(reworded.getByRole('textbox', { name: 'Memory' }), {
      target: { value: 'Jane owns billing.' }
    })
    reworded.unmount()
    expect(memory.reword).toHaveBeenCalledWith('Jane owns checkout.', 'Jane owns billing.')

    const cancelled = render(<BotMemoryList file={file(MEMORY)} edits={memory} />)
    fireEvent.change(cancelled.getByRole('textbox', { name: 'Add memory' }), {
      target: { value: 'Never mind' }
    })
    fireEvent.keyDown(cancelled.getByRole('textbox', { name: 'Add memory' }), { key: 'Escape' })
    cancelled.unmount()
    expect(memory.add).toHaveBeenCalledTimes(1)
  })
})
