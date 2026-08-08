// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  dispatchOrdinaryImplicitSubmit,
  dispatchRecordedImeImplicitSubmit
} from '../ime-enter-guarded-form.test-events'
import { PortForwardForm } from './PortsPanel'

const addPortForward = vi.fn(async () => ({ id: 'forward-1' }))

function renderForm(): HTMLInputElement {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ssh: { addPortForward } }
  })
  render(
    <PortForwardForm
      mode="add"
      initialRemotePort="3000"
      initialLocalPort="3000"
      initialRemoteHost="localhost"
      initialLabel="한국 서버"
      targetId="target-1"
      onClose={() => {}}
    />
  )
  return screen.getByPlaceholderText('3000') as HTMLInputElement
}

afterEach(() => {
  cleanup()
  addPortForward.mockClear()
})

describe('PortForwardForm IME implicit submit', () => {
  it('does not create a port forward on the recorded Korean Enter redispatch', () => {
    const input = renderForm()

    expect(dispatchRecordedImeImplicitSubmit(input)).toBe(true)
    expect(addPortForward).not.toHaveBeenCalled()
  })

  it('creates a port forward exactly once on an ordinary Enter', () => {
    const input = renderForm()

    expect(dispatchOrdinaryImplicitSubmit(input)).toBe(false)
    expect(addPortForward).toHaveBeenCalledOnce()
  })
})
