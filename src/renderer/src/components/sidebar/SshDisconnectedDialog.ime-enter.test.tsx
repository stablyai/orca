// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SshDisconnectedDialog } from './SshDisconnectedDialog'

function dispatchKey(type: 'keydown' | 'keyup', init: KeyboardEventInit): boolean {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init })
  Object.defineProperty(event, 'keyCode', { value: init.keyCode })
  act(() => window.dispatchEvent(event))
  return event.defaultPrevented
}

function renderDialog(): void {
  render(
    <SshDisconnectedDialog
      open
      onOpenChange={() => {}}
      targetId="ssh-1"
      targetLabel="Host"
      status="disconnected"
    />
  )
}

describe('SshDisconnectedDialog IME Enter ownership', () => {
  const connect = vi.fn(async () => {})

  beforeEach(() => {
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ssh: { connect } }
    })
  })

  afterEach(() => {
    cleanup()
    connect.mockClear()
  })

  it('does not reconnect on the recorded Korean Enter redispatch', () => {
    renderDialog()

    act(() => window.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    dispatchKey('keydown', {
      key: 'Process',
      code: 'Enter',
      keyCode: 229,
      isComposing: true
    })
    act(() => window.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))
    const prevented = dispatchKey('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })
    dispatchKey('keyup', { key: 'Process', keyCode: 229 })
    dispatchKey('keyup', { key: 'Enter', keyCode: 13 })

    expect(prevented).toBe(true)
    expect(connect).not.toHaveBeenCalled()
  })

  it('reconnects exactly once on ordinary Enter', () => {
    renderDialog()

    dispatchKey('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      isComposing: false
    })

    expect(connect).toHaveBeenCalledOnce()
    expect(connect).toHaveBeenCalledWith({ targetId: 'ssh-1' })
  })
})
