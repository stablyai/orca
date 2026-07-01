import { describe, expect, it } from 'vitest'
import {
  acceptTerminalTabTitleUpdate,
  createTerminalTabTitleReducerState
} from './terminal-tab-title-reducer'

describe('terminal tab title reducer', () => {
  it('ignores blank title frames without marking the reducer authoritative', () => {
    const state = createTerminalTabTitleReducerState()

    expect(
      acceptTerminalTabTitleUpdate(state, {
        target: 'icon',
        title: '   '
      })
    ).toBeNull()
    expect(
      acceptTerminalTabTitleUpdate(state, {
        target: 'window',
        title: 'Shell window title'
      })
    ).toEqual({
      title: 'Shell window title',
      source: 'legacy-window-fallback'
    })
  })
})
