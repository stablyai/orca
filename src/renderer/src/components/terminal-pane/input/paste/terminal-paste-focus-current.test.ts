// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { isTerminalPanePasteFocusCurrent } from './terminal-paste-target-state'

function xtermTextarea(): HTMLTextAreaElement {
  const textarea = document.createElement('textarea')
  textarea.classList.add('xterm-helper-textarea')
  return textarea
}

type DispatchState = 'in-pane' | 'removed-from-pane' | 'outside-pane'

function focusCurrentWith(
  dispatch: DispatchState,
  activeElement: Element | null,
  activeElementInPane = false
): boolean {
  const paneContainer = document.createElement('div')
  document.body.appendChild(paneContainer)
  const dispatchElement = xtermTextarea()
  if (dispatch === 'in-pane') {
    paneContainer.appendChild(dispatchElement)
  } else if (dispatch === 'removed-from-pane') {
    // Why: xterm replaces its helper textarea when a starting pane re-opens mid-paste (#41926).
    paneContainer.appendChild(dispatchElement)
    dispatchElement.remove()
  } else {
    document.body.appendChild(dispatchElement)
  }
  if (activeElementInPane && activeElement) {
    paneContainer.appendChild(activeElement)
  }
  return isTerminalPanePasteFocusCurrent({
    requireSameFocusedElement: true,
    activeElementAtDispatch: dispatchElement,
    paneContainer,
    activeElement
  })
}

describe('isTerminalPanePasteFocusCurrent', () => {
  it('keeps the paste when the dispatch element is removed and focus falls back to body', () => {
    expect(focusCurrentWith('removed-from-pane', document.body)).toBe(true)
  })

  it('keeps the paste when the dispatch element is removed and focus lands on the pane replacement textarea', () => {
    expect(focusCurrentWith('removed-from-pane', xtermTextarea(), true)).toBe(true)
  })

  it('cancels when the dispatch element is removed and another typing surface took focus', () => {
    expect(focusCurrentWith('removed-from-pane', document.createElement('input'))).toBe(false)
  })

  it('cancels when a connected dispatch element sits outside the pane container', () => {
    expect(focusCurrentWith('outside-pane', document.body)).toBe(false)
  })

  it('keeps the paste while the dispatch element stays focused in the pane', () => {
    const dispatchElement = xtermTextarea()
    const paneContainer = document.createElement('div')
    paneContainer.appendChild(dispatchElement)
    expect(
      isTerminalPanePasteFocusCurrent({
        requireSameFocusedElement: true,
        activeElementAtDispatch: dispatchElement,
        paneContainer,
        activeElement: dispatchElement
      })
    ).toBe(true)
  })
})
