// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  APP_MENU_SELECTION_ACTION_EVENT,
  dispatchAppMenuSelectionAction
} from './app-menu-selection-actions'

describe('app menu selection actions', () => {
  it.each(['copy', 'select-all'] as const)('reports whether %s has an owned target', (action) => {
    let receivedAction: unknown
    const handler = (event: Event): void => {
      if (event instanceof CustomEvent) {
        receivedAction = event.detail
      }
      event.preventDefault()
    }
    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, handler)

    const claimed = dispatchAppMenuSelectionAction(action)

    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, handler)
    expect(claimed).toBe(true)
    expect(receivedAction).toBe(action)
  })

  it('leaves unowned actions available for native fallback', () => {
    expect(dispatchAppMenuSelectionAction('copy')).toBe(false)
  })
})
