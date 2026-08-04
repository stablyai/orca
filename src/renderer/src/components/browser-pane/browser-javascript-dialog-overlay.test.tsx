// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { BrowserJavaScriptDialogOpenedEvent } from '../../../../shared/browser-javascript-dialog'
import { BrowserJavaScriptDialogOverlay } from './browser-javascript-dialog-overlay'

function dialog(
  overrides: Partial<BrowserJavaScriptDialogOpenedEvent> = {}
): BrowserJavaScriptDialogOpenedEvent {
  return {
    browserPageId: 'page-1',
    dialogId: 'dialog-1',
    dialogType: 'alert',
    message: 'Saved',
    defaultPromptText: '',
    origin: 'https://example.com',
    ...overrides
  }
}

afterEach(() => cleanup())

describe('BrowserJavaScriptDialogOverlay', () => {
  it('renders inside its browser viewport instead of a document-level portal', () => {
    const host = document.createElement('div')
    document.body.append(host)
    const { unmount } = render(
      <BrowserJavaScriptDialogOverlay
        dialog={dialog()}
        isActive={false}
        busy={false}
        onRespond={vi.fn()}
      />,
      { container: host }
    )

    expect(host.contains(screen.getByTestId('browser-javascript-dialog'))).toBe(true)
    unmount()
    host.remove()
  })

  it('submits prompt text with Enter', () => {
    const onRespond = vi.fn().mockResolvedValue(true)
    render(
      <BrowserJavaScriptDialogOverlay
        dialog={dialog({
          dialogType: 'prompt',
          message: 'Name this workspace',
          defaultPromptText: 'Draft'
        })}
        isActive
        busy={false}
        onRespond={onRespond}
      />
    )

    const input = screen.getByLabelText('Response')
    expect(input).toHaveValue('Draft')
    fireEvent.change(input, { target: { value: 'Final' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(onRespond).toHaveBeenCalledWith(true, 'Final')
  })

  it('traps Tab focus within the modal overlay', () => {
    render(
      <BrowserJavaScriptDialogOverlay
        dialog={dialog({ dialogType: 'confirm' })}
        isActive
        busy={false}
        onRespond={vi.fn()}
      />
    )

    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const ok = screen.getByRole('button', { name: 'OK' })
    ok.focus()
    fireEvent.keyDown(ok, { key: 'Tab' })
    expect(cancel).toHaveFocus()

    fireEvent.keyDown(cancel, { key: 'Tab', shiftKey: true })
    expect(ok).toHaveFocus()
  })

  it('ignores keyboard responses while busy', () => {
    const onRespond = vi.fn().mockResolvedValue(true)
    render(
      <BrowserJavaScriptDialogOverlay
        dialog={dialog({ dialogType: 'confirm' })}
        isActive
        busy
        onRespond={onRespond}
      />
    )

    const overlay = screen.getByTestId('browser-javascript-dialog')
    fireEvent.keyDown(overlay, { key: 'Enter' })
    fireEvent.keyDown(overlay, { key: 'Escape' })

    expect(onRespond).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'OK' })).toBeDisabled()
  })

  it('dismisses confirmations with Escape but accepts alerts', () => {
    const dismissConfirm = vi.fn().mockResolvedValue(true)
    const { rerender } = render(
      <BrowserJavaScriptDialogOverlay
        dialog={dialog({ dialogType: 'confirm' })}
        isActive
        busy={false}
        onRespond={dismissConfirm}
      />
    )

    fireEvent.keyDown(screen.getByTestId('browser-javascript-dialog'), { key: 'Escape' })
    expect(dismissConfirm).toHaveBeenCalledWith(false)

    const acceptAlert = vi.fn().mockResolvedValue(true)
    rerender(
      <BrowserJavaScriptDialogOverlay
        dialog={dialog()}
        isActive
        busy={false}
        onRespond={acceptAlert}
      />
    )
    fireEvent.keyDown(screen.getByTestId('browser-javascript-dialog'), { key: 'Escape' })
    expect(acceptAlert).toHaveBeenCalledWith(true, undefined)
  })
})
