// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileRelayMintFailureNotice } from './mobile-relay-mint-failure-notice'
import { useSendRelayMintFailureFeedback } from './relay-mint-failure-feedback'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() }
}))

const failure: MobileRelayMintFailure = {
  code: 'relay_binding_failed',
  stage: 'binding_failed',
  message: 'Could not bind the relay session.'
}

function SendButton(): React.JSX.Element {
  const relayDiagnostics = useSendRelayMintFailureFeedback()
  return (
    <button
      type="button"
      onClick={() => void relayDiagnostics.send({ failure, preferredConnectionMode: 'relay' })}
    >
      send
    </button>
  )
}

function RelayNoticeHarness(): React.JSX.Element {
  const relayDiagnostics = useSendRelayMintFailureFeedback()
  return (
    <MobileRelayMintFailureNotice
      failure={failure}
      onUseLan={vi.fn()}
      onRetry={vi.fn()}
      onCopyDiagnostics={vi.fn()}
      onSendDiagnostics={() =>
        void relayDiagnostics.send({ failure, preferredConnectionMode: 'relay' })
      }
      sendingDiagnostics={relayDiagnostics.sending}
    />
  )
}

function stubFeedbackApi(
  viewer: () => Promise<null>,
  submit: () => Promise<{ ok: true } | { ok: false; error: string }>
): void {
  vi.stubGlobal('window', Object.assign(window, { api: { gh: { viewer }, feedback: { submit } } }))
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useSendRelayMintFailureFeedback', () => {
  it('drops repeat clicks while a send is in flight so one gh spawn and one report go out', async () => {
    const user = userEvent.setup()
    let resolveViewer: (value: null) => void = () => {}
    const viewer = vi.fn(() => new Promise<null>((resolve) => (resolveViewer = resolve)))
    const submit = vi.fn(async () => ({ ok: true as const }))
    stubFeedbackApi(viewer, submit)

    render(<SendButton />)
    const button = screen.getByRole('button', { name: 'send' })
    await user.click(button)
    await user.click(button)
    await user.click(button)

    expect(viewer).toHaveBeenCalledTimes(1)
    resolveViewer(null)
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
  })

  it('disables Send to Orca and shows progress until the submit settles', async () => {
    const user = userEvent.setup()
    let resolveSubmit: (value: { ok: true }) => void = () => {}
    const viewer = vi.fn(async () => null)
    const submit = vi.fn(() => new Promise<{ ok: true }>((resolve) => (resolveSubmit = resolve)))
    stubFeedbackApi(viewer, submit)

    render(<RelayNoticeHarness />)
    await user.click(screen.getByRole('button', { name: 'Send to Orca' }))

    const sending = await screen.findByRole<HTMLButtonElement>('button', { name: 'Sending…' })
    expect(sending.disabled).toBe(true)

    resolveSubmit({ ok: true })
    const sent = await screen.findByRole<HTMLButtonElement>('button', { name: 'Send to Orca' })
    expect(sent.disabled).toBe(false)
  })
})
