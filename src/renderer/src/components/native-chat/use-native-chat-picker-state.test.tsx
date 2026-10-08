// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useNativeChatPickerState } from './use-native-chat-picker-state'

vi.mock('./use-native-chat-skills', () => ({
  useNativeChatSkills: () => ({ status: 'ready', skills: [], error: null, retry: () => {} })
}))

function pickerMode(draft: string, recalledFromHistory: boolean): string {
  const { result } = renderHook(() =>
    useNativeChatPickerState({
      agent: 'claude',
      terminalTabId: 'tab-1',
      draftScopeKey: 'pane-1',
      draft,
      caret: draft.length,
      agentCommands: [{ name: 'clear' }],
      recalledFromHistory,
      textareaRef: { current: null },
      setDraft: vi.fn(),
      setCaret: vi.fn(),
      setActiveSuggestion: vi.fn()
    })
  )
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
