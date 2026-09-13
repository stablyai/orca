// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { useBrowserAddressBarDismissal } from './use-browser-address-bar-dismissal'

afterEach(cleanup)

function Harness({ dismiss }: { dismiss: () => void }) {
  const input = useRef<HTMLInputElement>(null)
  useBrowserAddressBarDismissal(true, dismiss, input)
  return (
    <>
      <div data-slot="dialog-content" data-state="open">
        <input ref={input} aria-label="Address" />
      </div>
      <div data-slot="dialog-content" data-state="open">
        <button>Cancel removal</button>
      </div>
    </>
  )
}

it('lets a foreign modal receive Escape without dismissing address suggestions', () => {
  const dismiss = vi.fn()
  const view = render(<Harness dismiss={dismiss} />)
  const modalButton = view.getByRole('button', { name: 'Cancel removal' })
  const received = vi.fn()
  modalButton.addEventListener('keydown', received)
  fireEvent.keyDown(modalButton, { key: 'Escape' })
  expect(received).toHaveBeenCalledOnce()
  expect(dismiss).not.toHaveBeenCalled()
  fireEvent.keyDown(view.getByLabelText('Address'), { key: 'Escape' })
  expect(dismiss).not.toHaveBeenCalled()
  modalButton.parentElement?.setAttribute('data-state', 'closed')
  fireEvent.keyDown(view.getByLabelText('Address'), { key: 'Escape' })
  expect(dismiss).toHaveBeenCalledOnce()
})
