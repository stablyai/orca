// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { APP_MENU_SELECTION_ACTION_EVENT } from '@/lib/app-menu-selection-actions'
import { useAppMenuSelectionActions } from './useAppMenuSelectionActions'

let listener: ((action: 'copy' | 'select-all') => void) | null = null
const performNativeSelectionAction = vi.fn()

function Harness(): null {
  useAppMenuSelectionActions()
  return null
}

beforeEach(() => {
  listener = null
  performNativeSelectionAction.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: {
        onAppMenuSelectionAction: vi.fn((callback) => {
          listener = callback
          return () => {
            listener = null
          }
        }),
        performNativeSelectionAction
      }
    }
  })
})

afterEach(() => cleanup())

describe('useAppMenuSelectionActions', () => {
  it('falls back to native selection when no Orca surface claims the action', () => {
    render(<Harness />)

    act(() => listener?.('select-all'))

    expect(performNativeSelectionAction).toHaveBeenCalledWith('select-all')
  })

  it('does not run native selection after a terminal claims the action', () => {
    const claim = (event: Event): void => event.preventDefault()
    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, claim)
    render(<Harness />)

    act(() => listener?.('copy'))

    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, claim)
    expect(performNativeSelectionAction).not.toHaveBeenCalled()
  })
})
