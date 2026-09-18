// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { applyRootBackground } from './pane-divider'

describe('single-pane width cap', () => {
  it('publishes a px cap, and maps 0 to none so the pane is not collapsed', () => {
    const root = document.createElement('div')

    applyRootBackground(root, { singlePaneMaxWidth: 1100 })
    expect(root.style.getPropertyValue('--pane-single-max-width')).toBe('1100px')
    expect(root.style.getPropertyValue('--pane-single-edge-width')).toBe('1px')

    applyRootBackground(root, { singlePaneMaxWidth: 0 })
    expect(root.style.getPropertyValue('--pane-single-max-width')).toBe('none')
    // Uncapped must look exactly like before the feature: no edge lines.
    expect(root.style.getPropertyValue('--pane-single-edge-width')).toBe('0px')
  })

  it('leaves the CSS default in place when the setting is unset', () => {
    const root = document.createElement('div')
    applyRootBackground(root, {})
    expect(root.style.getPropertyValue('--pane-single-max-width')).toBe('')
    expect(root.style.getPropertyValue('--pane-single-edge-width')).toBe('')
  })
})
