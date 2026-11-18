// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeChatMentionMenu } from './composer/pickers/NativeChatAutocompleteMenus'
import { NativeChatRoomContext } from './native-chat-room-context'

const TWO_MEMBERS = {
  replies: null,
  mentions: [
    { name: 'Scout', icon: <span data-testid="scout-avatar" /> },
    { name: 'everyone', icon: null }
  ],
  withFiles: false,
  unavailable: []
}
const OTHER_BOTS = {
  replies: null,
  mentions: [
    { name: 'Docs', icon: null, detail: 'keeping the docs current' },
    { name: 'Release notes', icon: null, unavailable: 'Paused' }
  ],
  withFiles: true,
  unavailable: ['Release notes']
}

describe('NativeChatMentionMenu', () => {
  afterEach(cleanup)

  const NO_ROWS = { files: [], loading: false, failed: false }

  it('in a room, lists members by name with their icon instead of files', () => {
    const onChoose = vi.fn()
    render(
      <NativeChatRoomContext.Provider value={TWO_MEMBERS}>
        <NativeChatMentionMenu
          mention={{ ...NO_ROWS, files: ['Scout', 'everyone'] }}
          activeIndex={0}
          listboxId="members"
          onChoose={onChoose}
        />
      </NativeChatRoomContext.Provider>
    )
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Scout',
      'everyone'
    ])
    fireEvent.pointerDown(screen.getAllByRole('option')[1])
    expect(onChoose).toHaveBeenCalledWith('everyone')
  })

  it("in a bot's chat, lists the other bots above files, a paused one shown but not pickable", () => {
    const onChoose = vi.fn()
    render(
      <NativeChatRoomContext.Provider value={OTHER_BOTS}>
        <NativeChatMentionMenu
          mention={{ ...NO_ROWS, files: ['Docs', 'notes.md'] }}
          activeIndex={0}
          listboxId="bots"
          onChoose={onChoose}
        />
      </NativeChatRoomContext.Provider>
    )
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'DocsFor: keeping the docs current',
      'notes.md'
    ])
    expect(screen.getByText('Paused')).toBeTruthy()
    fireEvent.pointerDown(screen.getAllByRole('option')[0])
    expect(onChoose).toHaveBeenCalledWith('Docs')
  })
})
