// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobileRelayMintFailureNotice } from './mobile-relay-mint-failure-notice'
import type { MobileRelayMintFailure } from '../../../../shared/mobile-relay-mint-failure'

const failure: MobileRelayMintFailure = {
  code: 'relay_binding_failed',
  stage: 'binding_failed',
  message: 'Could not bind the relay session.'
}

afterEach(() => {
  cleanup()
})

describe('MobileRelayMintFailureNotice', () => {
  it('offers sending the diagnostics to Orca instead of only copying them', async () => {
    const user = userEvent.setup()
    const onSendDiagnostics = vi.fn()
    render(
      <MobileRelayMintFailureNotice
        failure={failure}
        onUseLan={vi.fn()}
        onRetry={vi.fn()}
        onCopyDiagnostics={vi.fn()}
        onSendDiagnostics={onSendDiagnostics}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Send to Orca' }))

    expect(onSendDiagnostics).toHaveBeenCalledTimes(1)
  })
})
