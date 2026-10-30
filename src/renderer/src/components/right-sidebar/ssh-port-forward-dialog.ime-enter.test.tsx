// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { endComposition } from '@/lib/ime-composition-event.test-support'
import { SshPortForwardDialog } from './ssh-port-forward-dialog'

const addPortForward = vi.fn(() => Promise.resolve())

beforeEach(() => {
  vi.useFakeTimers()
  addPortForward.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { ssh: { addPortForward } }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

// happy-dom has no implicit submission, so a keydown left unprevented submits the form here.
function pressEnterWithImplicitSubmit(field: HTMLElement): boolean {
  const notPrevented = fireEvent.keyDown(field, { key: 'Enter', keyCode: 13 })
  if (notPrevented) {
    fireEvent.submit(field.closest('form')!)
  }
  return notPrevented
}

describe('SshPortForwardDialog IME confirmation', () => {
  it.each([
    { field: 'Remote Port', value: '8080', sent: { remotePort: 8080 } },
    { field: 'Local Port', value: '18080', sent: { localPort: 18080 } },
    { field: 'Remote Host', value: '開発機', sent: { remoteHost: '開発機' } },
    { field: 'Label (optional)', value: '開発', sent: { label: '開発' } }
  ])('keeps the confirm redispatch in $field from submitting', async ({ field, value, sent }) => {
    render(
      <SshPortForwardDialog
        state={{ mode: 'add', defaults: { remotePort: 3000, targetId: 'target-1' } }}
        activeConnectionId="target-1"
        onClose={vi.fn()}
      />
    )
    const input = screen.getByLabelText(field)

    fireEvent.compositionStart(input)
    fireEvent.keyDown(input, { key: 'Process', keyCode: 229, isComposing: true })
    fireEvent.change(input, { target: { value } })
    endComposition(input, value)
    fireEvent.keyUp(input, { key: 'Process', keyCode: 229 })

    await act(async () => {
      expect(pressEnterWithImplicitSubmit(input)).toBe(false)
    })
    expect(addPortForward).not.toHaveBeenCalled()

    await act(async () => {
      expect(pressEnterWithImplicitSubmit(input)).toBe(true)
    })
    expect(addPortForward).toHaveBeenCalledOnce()
    expect(addPortForward).toHaveBeenCalledWith(expect.objectContaining(sent))
  })
})
