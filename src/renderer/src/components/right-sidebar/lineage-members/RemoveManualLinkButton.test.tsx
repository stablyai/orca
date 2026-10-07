// why: the button renders through React DOM, so @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toasts = vi.hoisted(() => ({ error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toasts }))

import { RemoveManualLinkButton } from './RemoveManualLinkButton'

const originalApi = window.api
const removeLink = vi.fn()
const onChanged = vi.fn()

beforeEach(() => {
  removeLink.mockReset()
  onChanged.mockReset()
  toasts.error.mockReset()
  Object.defineProperty(window, 'api', {
    configurable: true,
    writable: true,
    value: { ...originalApi, git: { lineageRemoveManualLink: removeLink } }
  })
})

afterEach(() => {
  cleanup()
  Object.defineProperty(window, 'api', { configurable: true, writable: true, value: originalApi })
})

function clickRemove(): void {
  render(
    <RemoveManualLinkButton
      parentWorkspaceKey="tower"
      linkId="m1"
      label="docs#5"
      onChanged={onChanged}
    />
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove docs#5' }))
}

describe('RemoveManualLinkButton', () => {
  it('removes the link and refreshes', async () => {
    removeLink.mockResolvedValue({ success: true })
    clickRemove()
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(removeLink).toHaveBeenCalledWith({ parentWorkspaceKey: 'tower', linkId: 'm1' })
    expect(toasts.error).not.toHaveBeenCalled()
  })

  it('reports a refused removal and does not refresh', async () => {
    removeLink.mockResolvedValue({ success: false })
    clickRemove()
    await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Could not remove docs#5'))
    expect(onChanged).not.toHaveBeenCalled()
  })

  it('reports a rejected IPC call', async () => {
    removeLink.mockRejectedValue(new Error('boom'))
    clickRemove()
    await waitFor(() =>
      expect(toasts.error).toHaveBeenCalledWith('Could not remove docs#5', { description: 'boom' })
    )
  })
})
