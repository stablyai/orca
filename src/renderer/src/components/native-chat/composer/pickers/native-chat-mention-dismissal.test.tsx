// @vitest-environment happy-dom
import { createRef, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatComposerInput } from '../editor/native-chat-composer-input'
import { NativeChatPromptEditor } from '../editor/NativeChatPromptEditor'
import { useNativeChatDraftEvents } from '../editor/use-native-chat-draft-events'
import { NativeChatRoomContext } from '../../native-chat-room-context'
import { NativeChatMentionMenu } from './NativeChatAutocompleteMenus'
import { useNativeChatPickerState } from './use-native-chat-picker-state'

vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], retry: () => {} })
}))

afterEach(cleanup)

const ROOM = {
  replies: null,
  mentions: [{ name: 'Eng - Neil', icon: null }],
  withFiles: false,
  unavailable: []
}

function setup() {
  const inputRef = createRef<NativeChatComposerInput>()
  function Composer({ scope }: { scope: string }) {
    const [draft, setDraft] = useState('ask @eng')
    const [caret, setCaret] = useState(8)
    const [active, setActive] = useState(0)
    const picker = useNativeChatPickerState({
      agent: 'claude',
      terminalTabId: 'tab',
      draftScopeKey: scope,
      draft,
      caret,
      agentCommands: [],
      recalledFromHistory: false,
      disabled: false,
      isComposing: () => false,
      mentionNameMatches: (query) => /^eng(?: n)?$/i.test(query),
      textareaRef: inputRef,
      setDraft,
      setCaret,
      setActiveSuggestion: setActive
    })
    const events = useNativeChatDraftEvents({
      draft,
      setDraft,
      setCaret,
      setActiveSuggestion: setActive,
      handleDraftOrCaretChange: picker.handleDraftOrCaretChange,
      flushDraftAppends: () => {},
      flushPendingAttachments: () => {}
    })
    return (
      <NativeChatRoomContext.Provider value={ROOM}>
        <NativeChatPromptEditor
          inputRef={inputRef}
          initialValue="ask @eng"
          disabled={false}
          placeholder="Message"
          onChange={(input) => events.onDraftChange(input.value, input)}
          onSelect={events.onTextareaSelect}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && picker.autocomplete.mode !== 'none') {
              picker.dismiss(picker.autocomplete.triggerKey)
            }
          }}
        />
        {picker.autocomplete.mode === 'mention' && (
          <NativeChatMentionMenu
            mention={{ files: ['Eng - Neil'], loading: false, failed: false }}
            activeIndex={active}
            listboxId={picker.listboxId}
            onChoose={picker.completeMention}
          />
        )}
      </NativeChatRoomContext.Provider>
    )
  }
  const view = render(<Composer scope="dismissal" />)
  const input = inputRef.current!
  act(() => input.setSelectionRange(8, 8))
  expect(screen.queryByRole('listbox')).not.toBeNull()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  return { input, changeContext: () => view.rerender(<Composer scope="another-chat" />) }
}

it('keeps the surviving @ dismissed through earlier prose edits and caret round trips', () => {
  const { input } = setup()
  act(() => input.setSelectionRange(1, 1))
  act(() => input.setSelectionRange(8, 8))
  expect(screen.queryByRole('listbox')).toBeNull()
  act(() => input.setSelectionRange(0, 0))
  act(() => input.insertText!('please '))
  act(() => input.setSelectionRange(15, 15))
  expect(input.value).toBe('please ask @eng')
  expect(screen.queryByRole('listbox')).toBeNull()
  act(() => input.insertText!(' '))
  act(() => input.insertText!('n'))
  expect(input.value).toBe('please ask @eng n')
  expect(screen.queryByRole('listbox')).toBeNull()
})

it('distinguishes query-only replacement from a fresh sigil at the same offset', () => {
  const { input, changeContext } = setup()
  act(() => input.setSelectionRange(7, 8))
  act(() => input.insertText!('G'))
  expect(input.value).toBe('ask @enG')
  expect(screen.queryByRole('listbox')).toBeNull()
  act(() => input.setSelectionRange(4, 8))
  act(() => input.insertText!('@enG'))
  expect(input.value).toBe('ask @enG')
  expect(input.selectionStart).toBe(8)
  expect(screen.queryByRole('listbox')).not.toBeNull()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  act(() => input.insertText!('\n@eng'))
  expect(input.value).toBe('ask @enG\n@eng')
  expect(screen.queryByRole('listbox')).not.toBeNull()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  expect(screen.queryByRole('listbox')).toBeNull()
  changeContext()
  expect(screen.queryByRole('listbox')).not.toBeNull()
})

it('opens a new @ after the old sigil or its word boundary is removed', () => {
  const { input } = setup()
  act(() => input.setSelectionRange(3, 4))
  act(() => input.insertText!('x'))
  expect(screen.queryByRole('listbox')).toBeNull()
  act(() => input.setSelectionRange(3, 4))
  act(() => input.insertText!(' '))
  act(() => input.setSelectionRange(8, 8))
  expect(screen.queryByRole('listbox')).not.toBeNull()
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' })
  act(() => input.setSelectionRange(4, 5))
  act(() => input.insertText!(''))
  act(() => input.setSelectionRange(4, 4))
  act(() => input.insertText!('@'))
  act(() => input.setSelectionRange(8, 8))
  expect(screen.queryByRole('listbox')).not.toBeNull()
})
