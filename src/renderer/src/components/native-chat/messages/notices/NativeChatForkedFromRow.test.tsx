// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatNoticeRow } from './NativeChatNoticeRow'
import { NativeChatForkedFromContext } from '../actions/native-chat-fork-context'
import type { NativeChatTextBlock } from '../../../../../../shared/native-chat/native-chat-types'

afterEach(cleanup)

const noopOpen = (): void => {}

function divider(
  sourceName: string,
  flags: { sourceForked?: true; sourceMissing?: true } = {}
): NativeChatTextBlock {
  return {
    type: 'text',
    text: `Forked from ${sourceName}`,
    presentation: 'forked-from',
    forkedFrom: { sessionId: 'source-chat', ...flags }
  }
}

it('opens the source from one button named by its visible words', () => {
  const open = vi.fn()
  render(
    <NativeChatForkedFromContext.Provider value={open}>
      <NativeChatNoticeRow block={divider('Annotate capabilities')} />
    </NativeChatForkedFromContext.Provider>
  )
  const pill = screen.getByRole('button', { name: 'Forked from Annotate capabilities' })
  fireEvent.click(pill)
  expect(open).toHaveBeenCalledWith('source-chat')
})

it('names a forked source with its fork mark', () => {
  render(
    <NativeChatForkedFromContext.Provider value={noopOpen}>
      <NativeChatNoticeRow block={divider('Annotate', { sourceForked: true })} />
    </NativeChatForkedFromContext.Provider>
  )
  expect(screen.getByRole('button', { name: 'Forked from Fork: Annotate' })).toBeInTheDocument()
})

it('offers no button for a source the host has no record of', () => {
  render(
    <NativeChatForkedFromContext.Provider value={noopOpen}>
      <NativeChatNoticeRow block={divider('another chat', { sourceMissing: true })} />
    </NativeChatForkedFromContext.Provider>
  )
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('Forked from another chat')).toBeInTheDocument()
})

it('shows the last known name as plain words while the source cannot be opened', () => {
  render(<NativeChatNoticeRow block={divider('Annotate capabilities')} />)
  expect(screen.queryByRole('button')).toBeNull()
  expect(document.body).toHaveTextContent('Forked from Annotate capabilities')
})
