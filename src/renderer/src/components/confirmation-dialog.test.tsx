// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({ setContextualToursBlockingSurfaceVisible: vi.fn() })
}))

import { ConfirmationDialogProvider } from './confirmation-dialog'
import {
  useConfirmationDialog,
  type ConfirmationDialogOptions
} from './confirmation-dialog-context'

function Harness({
  options,
  onSettled
}: {
  options: ConfirmationDialogOptions
  onSettled: (confirmed: boolean) => void
}): React.JSX.Element {
  const confirm = useConfirmationDialog()
  return (
    <button type="button" onClick={() => void confirm(options).then(onSettled)}>
      ask
    </button>
  )
}

function renderDialog(options: ConfirmationDialogOptions): { onSettled: ReturnType<typeof vi.fn> } {
  const onSettled = vi.fn()
  render(
    <ConfirmationDialogProvider>
      <Harness options={options} onSettled={onSettled} />
    </ConfirmationDialogProvider>
  )
  return { onSettled }
}

describe('ConfirmationDialogProvider', () => {
  afterEach(cleanup)

  it('omits the checkbox unless the caller opts in', async () => {
    renderDialog({ title: 'Delete artifact?' })

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    expect(await screen.findByText('Delete artifact?')).toBeInTheDocument()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('runs the skip callback when confirmed with the box checked', async () => {
    const onConfirmed = vi.fn()
    const { onSettled } = renderDialog({
      title: 'Delete artifact?',
      confirmLabel: 'Delete',
      dontAskAgain: { onConfirmed }
    })

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: "Don't ask again" }))
    await userEvent.click(screen.getByRole('button', { name: 'Delete' }))

    expect(onConfirmed).toHaveBeenCalledOnce()
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(true))
  })

  it('never saves the preference when the user backs out', async () => {
    const onConfirmed = vi.fn()
    const { onSettled } = renderDialog({
      title: 'Delete artifact?',
      dontAskAgain: { onConfirmed }
    })

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: "Don't ask again" }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    expect(onConfirmed).not.toHaveBeenCalled()
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(false))
  })

  it('does not carry a checked box into the next prompt', async () => {
    const onConfirmed = vi.fn()
    renderDialog({
      title: 'Delete artifact?',
      confirmLabel: 'Delete',
      dontAskAgain: { onConfirmed }
    })

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await userEvent.click(await screen.findByRole('checkbox', { name: "Don't ask again" }))
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    expect(await screen.findByRole('checkbox', { name: "Don't ask again" })).toHaveAttribute(
      'data-state',
      'unchecked'
    )
  })

  it('reports the opt-in as checked when the user ticks it and confirms', async () => {
    const onConfirm = vi.fn()
    const { onSettled } = renderDialog({
      title: 'Forget this launch?',
      confirmLabel: 'Forget launch',
      optIn: { label: 'Also forget 3 other stranded launches on devbox.', onConfirm }
    })

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await userEvent.click(
      await screen.findByRole('checkbox', {
        name: 'Also forget 3 other stranded launches on devbox.'
      })
    )
    await userEvent.click(screen.getByRole('button', { name: 'Forget launch' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(true))
    expect(onSettled).toHaveBeenCalledWith(true)
  })

  it('reports the opt-in as unchecked when confirmed without ticking it', async () => {
    const onConfirm = vi.fn()
    renderDialog({
      title: 't',
      confirmLabel: 'Forget launch',
      optIn: { label: 'x', onConfirm }
    })

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await screen.findByRole('checkbox')
    await userEvent.click(screen.getByRole('button', { name: 'Forget launch' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(false))
  })

  it('honors defaultChecked so a pre-ticked opt-in confirms as checked', async () => {
    const onConfirm = vi.fn()
    renderDialog({
      title: 't',
      confirmLabel: 'Forget launch',
      optIn: { label: 'x', defaultChecked: true, onConfirm }
    })

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await screen.findByRole('checkbox')
    await userEvent.click(screen.getByRole('button', { name: 'Forget launch' }))

    await waitFor(() => expect(onConfirm).toHaveBeenCalledWith(true))
  })

  it('does not fire the opt-in callback when the confirmation is cancelled', async () => {
    const onConfirm = vi.fn()
    const { onSettled } = renderDialog({
      title: 't',
      confirmLabel: 'Forget launch',
      optIn: { label: 'x', onConfirm }
    })

    await userEvent.click(screen.getByRole('button', { name: 'ask' }))
    await screen.findByRole('checkbox')
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(onSettled).toHaveBeenCalledWith(false))
    expect(onConfirm).not.toHaveBeenCalled()
  })
})
