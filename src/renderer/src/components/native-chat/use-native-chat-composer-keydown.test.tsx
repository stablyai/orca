// @vitest-environment happy-dom

import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { useState, type KeyboardEventHandler } from 'react'
import { describe, expect, it, vi } from 'vitest'
import {
  applyPickerSuggestion,
  deriveComposerAutocomplete,
  type ComposerAutocomplete
} from './native-chat-composer-state'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import { useNativeChatRecallPosition } from './use-native-chat-composer-recall'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'

const COMMAND = {
  kind: 'command' as const,
  id: 'command:clear',
  name: 'clear',
  token: '/clear',
  description: 'Clear history',
  skillCollision: false
}

function picker(items = [COMMAND]): Extract<ComposerAutocomplete, { mode: 'slash' }> {
  return {
    mode: 'slash',
    query: '',
    items,
    triggerKey: '/:0',
    prefix: '/',
    dispatchable: true,
    grouped: false,
    commandsEnabled: true,
    skillsEnabled: false,
    skillStatus: 'ready'
  }
}

function setup(
  autocomplete: ComposerAutocomplete = picker(),
  composing = false,
  draft = '/',
  {
    files = [],
    activeSuggestion = 0,
    loading = false
  }: { files?: readonly string[]; activeSuggestion?: number; loading?: boolean } = {}
) {
  const callbacks = {
    completeMention: vi.fn(),
    completePickerItem: vi.fn(),
    dispatchPickerCommand: vi.fn(),
    dismissPicker: vi.fn(),
    interrupt: vi.fn(),
    send: vi.fn(),
    setActiveSuggestion: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn()
  }
  const hook = renderHook(() =>
    useNativeChatComposerKeyDown({
      autocomplete,
      mentionFiles: { files, loading, failed: false },
      activeSuggestion,
      draft,
      isComposing: () => composing,
      ...callbacks
    })
  )
  return { handler: hook.result.current, callbacks }
}

function keyEvent(key: string, isComposing = false) {
  return {
    key,
    shiftKey: false,
    keyCode: isComposing ? 229 : 0,
    nativeEvent: { isComposing },
    preventDefault: vi.fn()
  }
}

describe('useNativeChatComposerKeyDown', () => {
  const mention: ComposerAutocomplete = { mode: 'mention', query: 'app', triggerKey: '@:5' }

  const setupMention = (options?: Parameters<typeof setup>[3]) =>
    setup(mention, false, 'open @app', options)

  function press(handler: KeyboardEventHandler<HTMLElement>, key: string, shiftKey = false): void {
    render(<div data-testid="composer" onKeyDown={handler} />)
    fireEvent.keyDown(screen.getByTestId('composer'), { key, shiftKey })
    cleanup()
  }

  it.each(['Enter', 'Tab'])('leaves Shift+%s alone while a menu is open', (key) => {
    const files = setupMention({ files: ['src/app.ts'] })
    press(files.handler, key, true)
    expect(files.callbacks.completeMention).not.toHaveBeenCalled()

    const commands = setup()
    press(commands.handler, key, true)
    expect(commands.callbacks.completePickerItem).not.toHaveBeenCalled()
    expect(commands.callbacks.dispatchPickerCommand).not.toHaveBeenCalled()
  })

  it('inserts the highlighted file on Enter instead of sending', () => {
    const { handler, callbacks } = setupMention({
      files: ['src/app.ts', 'app.css'],
      activeSuggestion: 1
    })
    press(handler, 'Enter')
    expect(callbacks.completeMention).toHaveBeenCalledWith('app.css')
    expect(callbacks.send).not.toHaveBeenCalled()
  })

  it('holds Enter while the files are still loading instead of sending a half-typed message', () => {
    const { handler, callbacks } = setupMention({ loading: true })
    press(handler, 'Enter')
    expect(callbacks.send).not.toHaveBeenCalled()
    expect(callbacks.completeMention).not.toHaveBeenCalled()
  })

  it('sends on Enter once the file menu has settled with nothing to insert', () => {
    const { handler, callbacks } = setupMention()
    press(handler, 'Enter')
    expect(callbacks.completeMention).not.toHaveBeenCalled()
    expect(callbacks.send).toHaveBeenCalled()
  })

  it('closes the file menu on Escape without interrupting the agent', () => {
    const { handler, callbacks } = setupMention({ files: ['src/app.ts'] })
    press(handler, 'Escape')
    expect(callbacks.dismissPicker).toHaveBeenCalledWith('@:5')
    expect(callbacks.interrupt).not.toHaveBeenCalled()
  })

  it('dispatches command Enter but completes command Tab', () => {
    const enter = setup()
    enter.handler(keyEvent('Enter') as never)
    expect(enter.callbacks.dispatchPickerCommand).toHaveBeenCalledWith(COMMAND)
    expect(enter.callbacks.completePickerItem).not.toHaveBeenCalled()

    const tab = setup()
    tab.handler(keyEvent('Tab') as never)
    expect(tab.callbacks.completePickerItem).toHaveBeenCalledWith(COMMAND)
    expect(tab.callbacks.dispatchPickerCommand).not.toHaveBeenCalled()
  })

  it('falls through to composer send when the open picker has no options', () => {
    const { handler, callbacks } = setup(picker([]))
    handler(keyEvent('Enter') as never)
    expect(callbacks.send).toHaveBeenCalledOnce()
  })

  it.each(['claude', 'openclaude', 'codex', 'grok'] as const)(
    'completes mid-prompt command Enter without dispatching or losing prose for %s',
    (agent) => {
      const draft = 'Explain /cle before continuing'
      const caret = 'Explain /cle'.length
      const autocomplete = deriveComposerAutocomplete(
        draft,
        caret,
        [COMMAND],
        [],
        getNativeChatAgentProfile(agent)
      )
      expect(autocomplete.mode).toBe('slash')
      const { handler, callbacks } = setup(autocomplete, false, draft)
      const event = keyEvent('Enter')
      handler(event as never)

      expect(event.preventDefault).toHaveBeenCalledOnce()
      expect(callbacks.dispatchPickerCommand).not.toHaveBeenCalled()
      expect(callbacks.send).not.toHaveBeenCalled()
      expect(callbacks.completePickerItem).toHaveBeenCalledOnce()
      const [item] = callbacks.completePickerItem.mock.calls[0]
      expect(applyPickerSuggestion(draft, caret, item)).toEqual({
        draft: 'Explain /clear  before continuing',
        caret: 'Explain /clear '.length,
        insertedToken: '/clear'
      })
    }
  )

  it('dismisses Escape without interrupting the agent', () => {
    const { handler, callbacks } = setup()
    handler(keyEvent('Escape') as never)
    expect(callbacks.dismissPicker).toHaveBeenCalledWith('/:0')
    expect(callbacks.interrupt).not.toHaveBeenCalled()
  })

  it('does not accept or submit while IME composition is active', () => {
    const { handler, callbacks } = setup(picker(), true)
    const event = keyEvent('Enter', true)
    handler(event as never)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.dispatchPickerCommand).not.toHaveBeenCalled()
    expect(callbacks.send).not.toHaveBeenCalled()
  })

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
        // The draft after the press, and whether the handler claimed the key.
        press: (key: string, init: KeyboardEventInit = {}) => {
          const claimed = !fireEvent.keyDown(field, { key, ...init })
          return { draft: field.value, claimed }
        }
      }
    }

    it('walks every prompt in the chat, back to the oldest and forward to an empty draft', () => {
      const { press } = setup({ prompts: ['one', 'two', 'three'] })
      expect(press('ArrowUp')).toEqual({ draft: 'three', claimed: true })
      expect(press('ArrowUp').draft).toBe('two')
      expect(press('ArrowUp').draft).toBe('one')
      expect(press('ArrowUp')).toEqual({ draft: 'one', claimed: false })
      expect(press('ArrowDown').draft).toBe('two')
      expect(press('ArrowDown').draft).toBe('three')
      expect(press('ArrowDown')).toEqual({ draft: '', claimed: true })
      expect(press('ArrowDown')).toEqual({ draft: '', claimed: false })
    })

    it('leaves the arrows to the caret while a typed draft is live', () => {
      const { press } = setup({ prompts: ['one'], initialDraft: 'typing' })
      expect(press('ArrowUp')).toEqual({ draft: 'typing', claimed: false })
    })

    it('treats an edited recall as a typed draft', () => {
      const { field, press } = setup({ prompts: ['one', 'two'] })
      press('ArrowUp')
      fireEvent.change(field, { target: { value: 'two, edited' } })
      expect(press('ArrowUp')).toEqual({ draft: 'two, edited', claimed: false })
      // Edited back to the recalled text, it is still a typed draft.
      fireEvent.change(field, { target: { value: 'two' } })
      expect(press('ArrowUp')).toEqual({ draft: 'two', claimed: false })
    })

    it('moves the caret inside a recalled prompt until it reaches the edge', () => {
      const isCaretOnVisualEdge = vi.fn((edge: 'start' | 'end') => edge === 'end')
      const { press } = setup({ prompts: ['one', 'two\nlines'], isCaretOnVisualEdge })
      isCaretOnVisualEdge.mockReturnValueOnce(true)
      press('ArrowUp')
      expect(press('ArrowUp')).toEqual({ draft: 'two\nlines', claimed: false })
      expect(press('ArrowDown')).toEqual({ draft: '', claimed: true })
    })

    it('does not recall on a modified arrow or into a composer holding attachments', () => {
      const selecting = setup({ prompts: ['one', 'two'] })
      selecting.press('ArrowUp')
      expect(selecting.press('ArrowUp', { shiftKey: true })).toEqual({
        draft: 'two',
        claimed: false
      })

      const attached = setup({ prompts: ['one'], hasAttachments: true })
      expect(attached.press('ArrowUp')).toEqual({ draft: '', claimed: false })
    })
  })
})
