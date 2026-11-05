// @vitest-environment happy-dom

import { fireEvent, render } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { useNativeChatRecallPosition } from './use-native-chat-composer-recall'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatComposerPromptSearch } from './use-native-chat-composer-prompt-search'

describe('useNativeChatComposerKeyDown', () => {
  describe('prompt recall', () => {
    const userMessage = (id: string, text: string): NativeChatMessage => ({
      id,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: null,
      source: 'transcript'
    })

    const onEveryEdge = (): boolean => true

    function Composer({
      prompts,
      initialDraft = '',
      hasAttachments,
      isCaretOnVisualEdge = onEveryEdge
    }: {
      prompts: string[]
      initialDraft?: string
      hasAttachments?: boolean
      isCaretOnVisualEdge?: (edge: 'start' | 'end') => boolean
    }): React.JSX.Element {
      const [draft, setDraft] = useState(initialDraft)
      const [recallPosition, setRecallPosition] = useNativeChatRecallPosition(draft)
      const onKeyDown = useNativeChatComposerKeyDown({
        autocomplete: { mode: 'none' },
        activeSuggestion: 0,
        draft,
        mentionFiles: { files: [], loading: false, failed: false },
        completeMention: vi.fn(),
        recall: {
          source: { messages: prompts.map((text, index) => userMessage(String(index), text)) },
          position: recallPosition,
          setPosition: setRecallPosition,
          isCaretOnVisualEdge,
          show: vi.fn()
        },
        isComposing: () => false,
        completePickerItem: vi.fn(),
        dispatchPickerCommand: vi.fn(),
        dismissPicker: vi.fn(),
        interrupt: vi.fn(),
        send: vi.fn(),
        setActiveSuggestion: vi.fn(),
        setDraft,
        setCaret: vi.fn(),
        ...(hasAttachments === undefined ? {} : { hasAttachments })
      })
      return (
        <textarea
          aria-label="composer"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
        />
      )
    }

    function setup(props: Parameters<typeof Composer>[0]) {
      const field = render(<Composer {...props} />).container.querySelector('textarea')!
      return {
        field,
        press: (key: string, init: KeyboardEventInit = {}) => {
          const claimed = !fireEvent.keyDown(field, { key, ...init })
          return { draft: field.value, claimed }
        }
      }
    }

    it('treats an edited recall as a typed draft', () => {
      const { field, press } = setup({ prompts: ['one', 'two'] })
      press('ArrowUp')
      fireEvent.change(field, { target: { value: 'two, edited' } })
      expect(press('ArrowUp')).toEqual({ draft: 'two, edited', claimed: false })
      // Edited back to the recalled text, it is still a typed draft.
      fireEvent.change(field, { target: { value: 'two' } })
      expect(press('ArrowUp')).toEqual({ draft: 'two', claimed: false })
    })
  })

  describe('prompt search', () => {
    const userMessage = (id: string, text: string): NativeChatMessage => ({
      id,
      role: 'user',
      blocks: [{ type: 'text', text }],
      timestamp: null,
      source: 'transcript'
    })

    const NO_AUTOCOMPLETE: ComposerAutocomplete = { mode: 'none' }

    function Composer({
      prompts,
      autocomplete = NO_AUTOCOMPLETE,
      initialDraft = '',
      callbacks
    }: {
      prompts: string[] | undefined
      autocomplete?: ComposerAutocomplete
      initialDraft?: string
      callbacks: { send: () => void; interrupt: () => void; completePickerItem: () => void }
    }): React.JSX.Element {
      const [draft, setDraft] = useState(initialDraft)
      const promptSearch = useNativeChatComposerPromptSearch({
        draft,
        source: prompts && {
          messages: prompts.map((text, index) => userMessage(String(index), text))
        },
        choosePrompt: setDraft
      })
      const onKeyDown = useNativeChatComposerKeyDown({
        autocomplete,
        activeSuggestion: 0,
        draft,
        mentionFiles: { files: [], loading: false, failed: false },
        completeMention: vi.fn(),
        promptSearch,
        isComposing: () => false,
        dispatchPickerCommand: vi.fn(),
        dismissPicker: vi.fn(),
        setActiveSuggestion: vi.fn(),
        setDraft,
        setCaret: vi.fn(),
        ...callbacks
      })
      const matches = promptSearch?.matches
      return (
        <>
          <textarea
            aria-label="composer"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {matches ? (
            <output aria-label="matches">
              {matches
                .map(({ prompt }, index) =>
                  index === promptSearch.activeIndex ? `[${prompt}]` : prompt
                )
                .join(' | ')}
            </output>
          ) : null}
        </>
      )
    }

    function setup(props: Omit<Parameters<typeof Composer>[0], 'callbacks'>) {
      const callbacks = { send: vi.fn(), interrupt: vi.fn(), completePickerItem: vi.fn() }
      const field = render(<Composer {...props} callbacks={callbacks} />).container.querySelector(
        'textarea'
      )!
      return {
        callbacks,
        type: (value: string) => fireEvent.change(field, { target: { value } }),
        press: (key: string, init: KeyboardEventInit = {}) =>
          !fireEvent.keyDown(field, { key, ...init }),
        draft: () => field.value,
        matches: () => screen.queryByLabelText('matches')?.textContent ?? null
      }
    }

    const PROMPTS = ['fix the build', 'write docs', 'fix the tests']

    it('filters sent prompts by the draft, newest first, and steps older on a repeated Ctrl+R', () => {
      const search = setup({ prompts: PROMPTS })
      expect(search.press('r', { ctrlKey: true })).toBe(true)
      expect(search.matches()).toBe('[fix the tests] | write docs | fix the build')
      search.type('fix')
      expect(search.matches()).toBe('[fix the tests] | fix the build')
      search.press('r', { ctrlKey: true })
      expect(search.matches()).toBe('fix the tests | [fix the build]')
      search.press('r', { ctrlKey: true })
      expect(search.matches()).toBe('fix the tests | [fix the build]')
      search.press('ArrowUp')
      expect(search.matches()).toBe('[fix the tests] | fix the build')
      cleanup()
    })

    it('puts the chosen prompt in the composer without sending it', () => {
      const search = setup({ prompts: PROMPTS })
      search.press('r', { ctrlKey: true })
      search.type('fix')
      search.press('ArrowDown')
      expect(search.press('Enter')).toBe(true)
      expect(search.draft()).toBe('fix the build')
      expect(search.matches()).toBeNull()
      expect(search.callbacks.send).not.toHaveBeenCalled()
      cleanup()
    })

    it('restarts at the newest match when the query changes', () => {
      const search = setup({ prompts: PROMPTS })
      search.press('r', { ctrlKey: true })
      search.type('fix')
      search.press('ArrowDown')
      search.type('fix the')
      expect(search.matches()).toBe('[fix the tests] | fix the build')
      cleanup()
    })

    it('closes on Escape, or on Enter with no match, keeping the query and sending nothing', () => {
      const search = setup({ prompts: PROMPTS })
      search.press('r', { ctrlKey: true })
      search.type('fix')
      search.press('Escape')
      expect([search.draft(), search.matches()]).toEqual(['fix', null])
      expect(search.callbacks.interrupt).not.toHaveBeenCalled()

      search.press('r', { ctrlKey: true })
      search.type('nothing like it')
      expect(search.matches()).toBe('')
      search.press('Enter')
      expect([search.draft(), search.matches()]).toEqual(['nothing like it', null])
      expect(search.callbacks.send).not.toHaveBeenCalled()
      cleanup()
    })

    it('takes Enter from an open slash picker', () => {
      const search = setup({
        prompts: ['/review the diff'],
        autocomplete: picker(),
        initialDraft: '/'
      })
      search.press('r', { ctrlKey: true })
      search.press('Enter')
      expect(search.draft()).toBe('/review the diff')
      expect(search.callbacks.completePickerItem).not.toHaveBeenCalled()
      cleanup()
    })

    it('opens on the physical R key of a non-Latin layout', () => {
      const search = setup({ prompts: PROMPTS })
      expect(search.press('к', { code: 'KeyR', ctrlKey: true })).toBe(true)
      expect(search.matches()).toBe('[fix the tests] | write docs | fix the build')
      cleanup()
    })

    it('leaves Ctrl+R alone where there is nothing to search, and Cmd+R to the app', () => {
      const editing = setup({ prompts: undefined })
      expect(editing.press('r', { ctrlKey: true })).toBe(false)
      cleanup()

      const search = setup({ prompts: PROMPTS })
      expect(search.press('r', { metaKey: true })).toBe(false)
      expect(search.matches()).toBeNull()
      cleanup()
    })
  })
})
