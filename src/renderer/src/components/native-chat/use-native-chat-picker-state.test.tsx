// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNativeChatPickerState } from './use-native-chat-picker-state'

vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))

function pickerMode(draft: string, recalledFromHistory: boolean): string {
  const setDraft = vi.fn()
  const { result, rerender } = renderHook(
    (disabled: boolean) =>
      useNativeChatPickerState({
        agent: 'claude',
        terminalTabId: 'tab-1',
        draftScopeKey: 'pane-1',
        draft,
        caret: draft.length,
        agentCommands: [{ name: 'clear' }],
        recalledFromHistory,
        disabled,
        isComposing: () => false,
        textareaRef: { current: null },
        setDraft,
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn()
      }),
    { initialProps: false }
  )
  const completeMention = result.current.completeMention
  const completeItem = result.current.completeItem
  const item =
    result.current.autocomplete.mode === 'slash' ? result.current.autocomplete.items[0] : null
  const typedMode = result.current.autocomplete.mode
  rerender(true)
  expect(result.current.autocomplete.mode).toBe('none')
  completeMention('app.ts')
  if (item) {
    completeItem(item)
  }
  expect(setDraft).not.toHaveBeenCalled()
  rerender(false)
  expect(result.current.autocomplete.mode).toBe(typedMode)
  return result.current.autocomplete.mode
}

describe('useNativeChatPickerState', () => {
  it.each([
    ['open @app', 'mention'],
    ['/cl', 'slash']
  ])('opens no menu on %s while it is a message recalled from history', (draft, typedMode) => {
    expect(pickerMode(draft, false)).toBe(typedMode)
    expect(pickerMode(draft, true)).toBe('none')
  })
})

it('owns demand for the actual slash-menu lifetime, including dismissal and unmount', () => {
  const onPickerDemand = vi.fn()
  const { result, rerender, unmount } = renderHook(
    (draft: string) =>
      useNativeChatPickerState({
        agent: 'claude',
        terminalTabId: 'tab-1',
        draftScopeKey: 'pane-1',
        draft,
        caret: draft.length,
        agentCommands: [{ name: 'clear' }],
        recalledFromHistory: false,
        disabled: false,
        isComposing: () => false,
        textareaRef: { current: null },
        setDraft: vi.fn(),
        setCaret: vi.fn(),
        setActiveSuggestion: vi.fn(),
        onPickerDemand
      }),
    { initialProps: '' }
  )
  expect(onPickerDemand).toHaveBeenLastCalledWith(false)
  rerender('/cl')
  expect(onPickerDemand).toHaveBeenLastCalledWith(true)
  const autocomplete = result.current.autocomplete
  if (autocomplete.mode !== 'slash') {
    throw new Error('Expected the slash menu')
  }
  act(() => result.current.dismiss(autocomplete.triggerKey))
  expect(onPickerDemand).toHaveBeenLastCalledWith(false)
  unmount()
  expect(onPickerDemand).toHaveBeenLastCalledWith(false)
})
