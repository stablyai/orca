import { describe, expect, it } from 'vitest'
import type { FocusClickSuppressionInput } from './pane-focus-click-suppression'
import { shouldSwallowFocusClick } from './pane-focus-click-suppression'

// A plain left click with a mouse on an inactive, mouse-tracking pane.
const REACTIVATING_CLICK: FocusClickSuppressionInput = {
  paneWasActive: false,
  focusesTerminal: true,
  mouseTrackingMode: 'vt200',
  pointerType: 'mouse',
  isPrimaryPointer: true,
  button: 0,
  modifierHeld: false
}

describe('shouldSwallowFocusClick', () => {
  it('swallows the click that reactivates a pane running a mouse-aware TUI', () => {
    expect(shouldSwallowFocusClick(REACTIVATING_CLICK)).toBe(true)
  })

  it.each([
    // Already focused — the click is aimed at the TUI, so it must land.
    { override: { paneWasActive: true }, why: 'pane already active' },
    // No tracking: swallowing would break click-to-place in an inactive pane.
    { override: { mouseTrackingMode: 'none' }, why: 'no mouse tracking' },
    // Pane-local app control (title editor); xterm never sees this click anyway.
    { override: { focusesTerminal: false }, why: 'not headed for the terminal' },
    // Touch/pen may never produce the compatibility mousedown this arms for.
    { override: { pointerType: 'touch' }, why: 'touch pointer' },
    { override: { pointerType: 'pen' }, why: 'pen pointer' },
    { override: { isPrimaryPointer: false }, why: 'secondary pointer' },
    // Middle-click paste and the context menu are routed by button.
    { override: { button: 1 }, why: 'middle button' },
    { override: { button: 2 }, why: 'right button' },
    // Shift/Cmd/Ctrl/Alt clicks are the documented way past mouse tracking.
    { override: { modifierHeld: true }, why: 'modifier held' }
  ])('leaves the click alone — $why', ({ override }) => {
    expect(shouldSwallowFocusClick({ ...REACTIVATING_CLICK, ...override })).toBe(false)
  })
})
