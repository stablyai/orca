import { describe, expect, it } from 'vitest'
import {
  getAvailableQuickCommandHostId,
  isQuickCommandEditorHostCurrent,
  shouldOpenQuickCommandAddIntent,
  shouldShowQuickCommandsRefreshError
} from './quick-commands-pane-host-state'

describe('QuickCommandsPane add-command intent', () => {
  it('opens the add flow once for each new intent signal', () => {
    expect(shouldOpenQuickCommandAddIntent(undefined, 0)).toBe(false)
    expect(shouldOpenQuickCommandAddIntent(0, 0)).toBe(false)
    expect(shouldOpenQuickCommandAddIntent(1, 0)).toBe(true)
    expect(shouldOpenQuickCommandAddIntent(1, 1)).toBe(false)
    expect(shouldOpenQuickCommandAddIntent(2, 1)).toBe(true)
  })
})

describe('QuickCommandsPane host state', () => {
  it('falls back to the local host when the selected remote host disappears', () => {
    expect(
      getAvailableQuickCommandHostId('runtime:removed', [
        { id: 'local' },
        { id: 'runtime:available' }
      ])
    ).toBe('local')
  })

  it('keeps the selected host while it remains available', () => {
    expect(
      getAvailableQuickCommandHostId('runtime:available', [
        { id: 'local' },
        { id: 'runtime:available' }
      ])
    ).toBe('runtime:available')
  })

  it('retires a remote editor when the same host reconnects with a new generation', () => {
    expect(
      isQuickCommandEditorHostCurrent(
        'runtime:build',
        3,
        [{ id: 'local' }, { id: 'runtime:build' }],
        new Map([['build', { connectionGeneration: 4 }]])
      )
    ).toBe(false)
  })

  it('surfaces refresh failures only when cached commands remain usable', () => {
    expect(shouldShowQuickCommandsRefreshError(true, { error: 'offline', ready: true })).toBe(true)
    expect(shouldShowQuickCommandsRefreshError(true, { error: 'offline', ready: false })).toBe(
      false
    )
    expect(shouldShowQuickCommandsRefreshError(false, { error: 'offline', ready: true })).toBe(
      false
    )
  })
})
