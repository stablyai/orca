// @vitest-environment happy-dom

import React from 'react'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NativeChatWaitBlockedBanner } from './NativeChatWaitBlockedBanner'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('NativeChatWaitBlockedBanner', () => {
  it('names the dialog class and offers the terminal switch', () => {
    act(() => {
      root.render(
        React.createElement(NativeChatWaitBlockedBanner, {
          reason: 'codex-update-prompt',
          onSwitchToTerminal: () => {}
        })
      )
    })
    expect(container.textContent).toContain('an update prompt')
    expect(container.textContent).toContain('Terminal view')
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Terminal view'
    )
    expect(button).toBeTruthy()
  })

  it('switches to the terminal view when the button is clicked', () => {
    const onSwitchToTerminal = vi.fn()
    act(() => {
      root.render(
        React.createElement(NativeChatWaitBlockedBanner, {
          reason: 'agent-approval-prompt',
          onSwitchToTerminal
        })
      )
    })
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'Terminal view'
    )
    act(() => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onSwitchToTerminal).toHaveBeenCalledTimes(1)
  })

  it('renders without a switch affordance when no handler is given', () => {
    act(() => {
      root.render(React.createElement(NativeChatWaitBlockedBanner, { reason: 'codex-trust-workspace' }))
    })
    expect(container.textContent).toContain('a workspace trust prompt')
    expect(container.querySelector('button')).toBeNull()
  })
})
