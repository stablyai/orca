import { describe, expect, it } from 'vitest'
import { resolvePaneHeaderButtonsOnHover } from './terminal-pane-header-buttons-mode'

describe('resolvePaneHeaderButtonsOnHover', () => {
  it('hides the buttons until hover only when the setting asks for it', () => {
    expect(resolvePaneHeaderButtonsOnHover('hover', null)).toBe(true)
    expect(resolvePaneHeaderButtonsOnHover('always', null)).toBe(false)
    expect(resolvePaneHeaderButtonsOnHover(undefined, null)).toBe(false)
  })

  it('shows the buttons while the split-pane tour points at the split button', () => {
    expect(resolvePaneHeaderButtonsOnHover('hover', 'workspace-agent-sessions')).toBe(false)
    expect(resolvePaneHeaderButtonsOnHover('hover', 'browser')).toBe(true)
  })
})
