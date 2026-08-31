// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  APP_MENU_SELECTION_ACTION_EVENT,
  type AppMenuSelectionAction
} from '@/lib/app-menu-selection-actions'
import { useAppMenuSelectionActions } from '@/hooks/useAppMenuSelectionActions'
import { useNativeChatComposerAppMenuSelection } from './use-native-chat-composer-app-menu-selection'

let appMenuListener: ((action: AppMenuSelectionAction) => void) | null = null
const performNativeSelectionAction = vi.fn()

function AppMenuBoundary(): null {
  useAppMenuSelectionActions()
  return null
}

function ComposerHarness(): React.JSX.Element {
  const { textareaRef, isComposingRef } = useNativeChatComposerAppMenuSelection()
  return (
    <div>
      <textarea
        aria-label="Composer"
        ref={textareaRef}
        defaultValue={'first line\nsecond line'}
        onCompositionStart={() => {
          isComposingRef.current = true
        }}
        onCompositionEnd={() => {
          isComposingRef.current = false
        }}
      />
      <button type="button">Outside composer</button>
    </div>
  )
}

function emitAppMenuAction(action: AppMenuSelectionAction): void {
  act(() => {
    if (!appMenuListener) {
      throw new Error('app menu listener is not registered')
    }
    appMenuListener(action)
  })
}

function renderBoundaryAndComposer() {
  const boundary = render(<AppMenuBoundary />)
  const composer = render(<ComposerHarness />)
  return { boundary, composer }
}

beforeEach(() => {
  appMenuListener = null
  performNativeSelectionAction.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onAppMenuSelectionAction: vi.fn((listener: typeof appMenuListener) => {
          appMenuListener = listener
          return () => {
            appMenuListener = null
          }
        }),
        performNativeSelectionAction
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('native chat app-menu selection ownership', () => {
  it('selects the focused multiline composer through the app-menu boundary', () => {
    const { composer } = renderBoundaryAndComposer()
    const textarea = composer.getByRole('textbox', { name: 'Composer' }) as HTMLTextAreaElement
    textarea.focus()
    textarea.setSelectionRange(4, 4)

    emitAppMenuAction('select-all')

    expect(textarea.selectionStart).toBe(0)
    expect(textarea.selectionEnd).toBe(textarea.value.length)
    expect(performNativeSelectionAction).not.toHaveBeenCalled()
  })

  it('preserves global fallback when focus is outside the composer', () => {
    const { composer } = renderBoundaryAndComposer()
    const textarea = composer.getByRole('textbox', { name: 'Composer' }) as HTMLTextAreaElement
    textarea.setSelectionRange(4, 4)
    composer.getByRole('button', { name: 'Outside composer' }).focus()

    emitAppMenuAction('select-all')

    expect(textarea.selectionStart).toBe(4)
    expect(textarea.selectionEnd).toBe(4)
    expect(performNativeSelectionAction).toHaveBeenCalledOnce()
    expect(performNativeSelectionAction).toHaveBeenCalledWith('select-all')
  })

  it('leaves non-select-all actions unclaimed', () => {
    const { composer } = renderBoundaryAndComposer()
    const textarea = composer.getByRole('textbox', { name: 'Composer' }) as HTMLTextAreaElement
    textarea.focus()

    emitAppMenuAction('copy')

    expect(performNativeSelectionAction).toHaveBeenCalledOnce()
    expect(performNativeSelectionAction).toHaveBeenCalledWith('copy')
  })

  it('claims select-all during active IME composition without selecting or falling back', () => {
    const { composer } = renderBoundaryAndComposer()
    const textarea = composer.getByRole('textbox', { name: 'Composer' }) as HTMLTextAreaElement
    textarea.focus()
    textarea.setSelectionRange(4, 4)
    fireEvent.compositionStart(textarea)

    emitAppMenuAction('select-all')

    expect(textarea.selectionStart).toBe(4)
    expect(textarea.selectionEnd).toBe(4)
    expect(performNativeSelectionAction).not.toHaveBeenCalled()
  })

  it('removes composer ownership on cleanup', () => {
    const addEventListener = vi.spyOn(window, 'addEventListener')
    const removeEventListener = vi.spyOn(window, 'removeEventListener')
    const { composer } = renderBoundaryAndComposer()
    const listener = addEventListener.mock.calls.find(
      ([eventName]) => eventName === APP_MENU_SELECTION_ACTION_EVENT
    )?.[1]

    composer.unmount()

    expect(listener).toBeDefined()
    expect(removeEventListener).toHaveBeenCalledWith(APP_MENU_SELECTION_ACTION_EVENT, listener)
    emitAppMenuAction('select-all')
    expect(performNativeSelectionAction).toHaveBeenCalledWith('select-all')
  })
})
