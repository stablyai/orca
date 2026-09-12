// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest'
import {
  APP_MENU_SELECTION_ACTION_EVENT,
  dispatchAppMenuSelectionAction
} from './app-menu-selection-actions'

describe('app menu selection actions', () => {
  it.each(['copy', 'select-all'] as const)('reports whether %s has an owned target', (action) => {
    const handler = (event: Event): void => event.preventDefault()
    window.addEventListener(APP_MENU_SELECTION_ACTION_EVENT, handler)

    expect(dispatchAppMenuSelectionAction(action)).toBe(true)

    window.removeEventListener(APP_MENU_SELECTION_ACTION_EVENT, handler)
  })

  it('leaves unowned actions available for native fallback', () => {
    expect(dispatchAppMenuSelectionAction('copy')).toBe(false)
  })
})
