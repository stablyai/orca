// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyPickerSuggestion,
  deriveComposerAutocomplete,
  EMPTY_HISTORY,
  type ComposerAutocomplete
} from './native-chat-composer-state'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import type { NativeChatSendShortcut } from '../../../../shared/native-chat-send-shortcut'

const COMMAND = {
  kind: 'command' as const,
  id: 'command:clear',
  name: 'clear',
  token: '/clear',
  description: 'Clear history',
  skillCollision: false
}

/** Builds slash-picker state for keyboard-handler tests. */
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

/** Renders the keyboard handler with controlled test callbacks and state. */
function setup(
  autocomplete: ComposerAutocomplete = picker(),
  composing = false,
  draft = '/',
  nativeChatSendShortcut: NativeChatSendShortcut = 'enter'
) {
  const callbacks = {
    completePickerItem: vi.fn(),
    dispatchPickerCommand: vi.fn(),
    dismissPicker: vi.fn(),
    interrupt: vi.fn(),
    send: vi.fn(),
    setActiveSuggestion: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn(),
    setHistory: vi.fn()
  }
  const hook = renderHook(() =>
    useNativeChatComposerKeyDown({
      autocomplete,
      nativeChatSendShortcut,
      activeSuggestion: 0,
      draft,
      history: EMPTY_HISTORY,
      isComposing: () => composing,
      ...callbacks
    })
  )
  return { handler: hook.result.current, callbacks }
}

/** Creates a keyboard event fixture with optional platform modifiers. */
function keyEvent(
  key: string,
  isComposing = false,
  modifiers: Partial<Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'>> = {}
) {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
    keyCode: isComposing ? 229 : 0,
    nativeEvent: { isComposing },
    preventDefault: vi.fn()
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('useNativeChatComposerKeyDown', () => {
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

  it('sends plain Enter from an empty slash picker in Enter mode', () => {
    const { handler, callbacks } = setup(picker([]))
    const event = keyEvent('Enter')

    handler(event as never)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.send).toHaveBeenCalledOnce()
  })

  it('leaves plain Enter available for newlines from an empty slash picker in modifier mode', () => {
    const { handler, callbacks } = setup(picker([]), false, '/', 'cmd-or-ctrl-enter')
    const event = keyEvent('Enter')

    handler(event as never)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(callbacks.send).not.toHaveBeenCalled()
  })

  it('sends the configured chord from an empty slash picker in modifier mode', () => {
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    const { handler, callbacks } = setup(picker([]), false, '/', 'cmd-or-ctrl-enter')
    const event = keyEvent('Enter', false, { ctrlKey: true })

    handler(event as never)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.send).toHaveBeenCalledOnce()
  })

  it('does not send an unmatched mid-prompt slash token on plain Enter in modifier mode', () => {
    const profile = getNativeChatAgentProfile('codex')
    const autocomplete = deriveComposerAutocomplete('inspect /unknown', 16, [], [], profile)
    expect(autocomplete).toMatchObject({ mode: 'slash', items: [] })
    const { handler, callbacks } = setup(
      autocomplete,
      false,
      'inspect /unknown',
      'cmd-or-ctrl-enter'
    )
    const event = keyEvent('Enter')

    handler(event as never)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(callbacks.send).not.toHaveBeenCalled()
  })

  it('sends an unmatched mid-prompt slash token on the configured chord in modifier mode', () => {
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    const profile = getNativeChatAgentProfile('codex')
    const autocomplete = deriveComposerAutocomplete('inspect /unknown', 16, [], [], profile)
    expect(autocomplete).toMatchObject({ mode: 'slash', items: [], dispatchable: false })
    const { handler, callbacks } = setup(
      autocomplete,
      false,
      'inspect /unknown',
      'cmd-or-ctrl-enter'
    )
    const event = keyEvent('Enter', false, { ctrlKey: true })

    handler(event as never)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.send).toHaveBeenCalledOnce()
  })

  it.each([
    ['Macintosh', { metaKey: true }],
    ['Windows NT', { ctrlKey: true }],
    ['Linux', { ctrlKey: true }]
  ] as const)('sends the configured platform chord on %s', (userAgent, modifiers) => {
    vi.stubGlobal('navigator', { userAgent })
    const { handler, callbacks } = setup({ mode: 'none' }, false, '/', 'cmd-or-ctrl-enter')
    const event = keyEvent('Enter', false, modifiers)

    handler(event as never)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.send).toHaveBeenCalledOnce()
  })

  it('leaves plain Enter available for newlines in modifier mode', () => {
    const { handler, callbacks } = setup({ mode: 'none' }, false, '/', 'cmd-or-ctrl-enter')
    const event = keyEvent('Enter')

    handler(event as never)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(callbacks.send).not.toHaveBeenCalled()
  })

  it('preserves slash command Enter behavior in modifier mode', () => {
    const { handler, callbacks } = setup(picker(), false, '/', 'cmd-or-ctrl-enter')
    const event = keyEvent('Enter')

    handler(event as never)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.dispatchPickerCommand).toHaveBeenCalledWith(COMMAND)
    expect(callbacks.send).not.toHaveBeenCalled()
  })

  it('preserves slash picker precedence for the configured send chord', () => {
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    const { handler, callbacks } = setup(picker(), false, '/', 'cmd-or-ctrl-enter')
    const event = keyEvent('Enter', false, { ctrlKey: true })

    handler(event as never)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.dispatchPickerCommand).toHaveBeenCalledWith(COMMAND)
    expect(callbacks.send).not.toHaveBeenCalled()
  })

  it('does not send or consume an invalid modifier chord', () => {
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    const { handler, callbacks } = setup({ mode: 'none' }, false, '/', 'cmd-or-ctrl-enter')
    const event = keyEvent('Enter', false, { metaKey: true })

    handler(event as never)

    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(callbacks.send).not.toHaveBeenCalled()
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

  it('does not send a configured chord while IME composition is active', () => {
    vi.stubGlobal('navigator', { userAgent: 'Linux' })
    const { handler, callbacks } = setup({ mode: 'none' }, true, '/', 'cmd-or-ctrl-enter')
    const event = keyEvent('Enter', true, { ctrlKey: true })

    handler(event as never)

    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(callbacks.send).not.toHaveBeenCalled()
  })
})
