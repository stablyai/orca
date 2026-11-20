// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
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

const NO_BOT_MATCH = { ...OTHER_BOTS, unavailable: [], query: 'notes' }

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
    expect(screen.getByTestId('scout-avatar')).toBeTruthy()
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
    expect(
      screen.getByRole('option', { name: /Release notes/ }).getAttribute('aria-disabled')
    ).toBe('true')
    fireEvent.pointerDown(screen.getAllByRole('option')[0])
    expect(onChoose).toHaveBeenCalledWith('Docs')
    fireEvent.pointerDown(screen.getAllByRole('option')[1])
    expect(onChoose).toHaveBeenCalledTimes(1)
  })

  it('moves the one highlight with real pointer movement only', () => {
    function Menu() {
      const [activeIndex, setActiveIndex] = useState(0)
      return (
        <NativeChatRoomContext.Provider value={OTHER_BOTS}>
          <NativeChatMentionMenu
            mention={{ ...NO_ROWS, files: ['Docs', 'notes.md'] }}
            activeIndex={activeIndex}
            listboxId="bots"
            onChoose={() => {}}
            onHover={setActiveIndex}
          />
        </NativeChatRoomContext.Provider>
      )
    }
    render(<Menu />)
    const docs = screen.getByRole('option', { name: /Docs/ })
    const notes = screen.getByRole('option', { name: 'notes.md' })
    fireEvent.mouseEnter(notes)
    expect(docs.getAttribute('aria-selected')).toBe('true')
    // The first mousemove can come from opening the menu under a resting pointer.
    fireEvent.mouseMove(notes, { clientX: 10, clientY: 40, movementX: 0, movementY: 0 })
    expect(docs.getAttribute('aria-selected')).toBe('true')
    expect(notes.getAttribute('aria-selected')).toBe('false')
    fireEvent.mouseMove(notes, { movementX: 0, movementY: 3 })
    expect(docs.getAttribute('aria-selected')).toBe('false')
    expect(notes.getAttribute('aria-selected')).toBe('true')
  })

  it("in a bot's chat, lets a matching file be picked when no bot matches", () => {
    const onChoose = vi.fn()
    render(
      <NativeChatRoomContext.Provider value={NO_BOT_MATCH}>
        <NativeChatMentionMenu
          mention={{ ...NO_ROWS, files: ['notes.md'] }}
          activeIndex={0}
          listboxId="bots"
          onChoose={onChoose}
        />
      </NativeChatRoomContext.Provider>
    )
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(['notes.md'])
    fireEvent.pointerDown(screen.getByRole('option', { name: 'notes.md' }))
    expect(onChoose).toHaveBeenCalledWith('notes.md')
  })
})
