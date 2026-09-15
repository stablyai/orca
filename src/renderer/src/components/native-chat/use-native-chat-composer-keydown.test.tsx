// @vitest-environment happy-dom

import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  applyPickerSuggestion,
  deriveComposerAutocomplete,
  EMPTY_HISTORY,
  type ComposerAutocomplete
} from './native-chat-composer-state'
import { getNativeChatAgentProfile } from '../../../../shared/native-chat-agent-profiles'
import {
  useNativeChatComposerKeyDown,
  type UseNativeChatComposerKeyDownArgs
} from './use-native-chat-composer-keydown'

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

const defaultMatchesSubmitKey: UseNativeChatComposerKeyDownArgs['matchesSubmitKey'] = (event) =>
  event.key === 'Enter' && !event.shiftKey

function setup(
  autocomplete: ComposerAutocomplete = picker(),
  composing = false,
  draft = '/',
  matchesSubmitKey: UseNativeChatComposerKeyDownArgs['matchesSubmitKey'] = defaultMatchesSubmitKey
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
      activeSuggestion: 0,
      draft,
      history: EMPTY_HISTORY,
      isComposing: () => composing,
      matchesSubmitKey,
      ...callbacks
    })
  )
  return { handler: hook.result.current, callbacks }
}

function keyEvent(
  key: string,
  isComposing = false,
  mods: { alt?: boolean; ctrl?: boolean; meta?: boolean; shift?: boolean } = {}
) {
  return {
    key,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    keyCode: isComposing ? 229 : 0,
    nativeEvent: { isComposing },
    preventDefault: vi.fn()
  }
}

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

  it('submits on the injected gesture and treats a non-matching Enter as a newline', () => {
    const altEnterOnly: UseNativeChatComposerKeyDownArgs['matchesSubmitKey'] = (event) =>
      event.key === 'Enter' && event.altKey

    const plainEnter = setup(picker([]), false, '/', altEnterOnly)
    plainEnter.handler(keyEvent('Enter') as never)
    expect(plainEnter.callbacks.send).not.toHaveBeenCalled()

    const altEnter = setup(picker([]), false, '/', altEnterOnly)
    altEnter.handler(keyEvent('Enter', false, { alt: true }) as never)
    expect(altEnter.callbacks.send).toHaveBeenCalledOnce()
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
})
