// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import CloseTerminalDialog from './CloseTerminalDialog'

function renderStopDialog(): {
  onConfirm: ReturnType<typeof vi.fn>
  onCancel: ReturnType<typeof vi.fn>
} {
  const onConfirm = vi.fn()
  const onCancel = vi.fn()
  render(
    <CloseTerminalDialog
      open
      copyKind="agent"
      workspaceName="worker"
      onSleepInstead={() => {}}
      onConfirm={onConfirm}
      onCancel={onCancel}
    />
  )
  return { onConfirm, onCancel }
}

describe('CloseTerminalDialog', () => {
  afterEach(cleanup)

  it('focuses Stop so Enter confirms', async () => {
    const { onConfirm, onCancel } = renderStopDialog()
    // The busiest prompt layout: Sleep instead and Cancel both render before Stop.
    const stop = await screen.findByRole('button', { name: 'Stop agent' })
    await waitFor(() => expect(stop).toHaveFocus())
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(false))
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('keeps Escape on Cancel', async () => {
    const { onConfirm, onCancel } = renderStopDialog()
    await screen.findByRole('button', { name: 'Stop agent' })
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(onCancel).toHaveBeenCalledOnce())
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
