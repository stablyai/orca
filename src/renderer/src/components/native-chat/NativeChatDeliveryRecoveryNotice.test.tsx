// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { NativeChatDeliveryRecoveryNotice } from './NativeChatDeliveryRecoveryNotice'

describe('NativeChatDeliveryRecoveryNotice', () => {
  it('shows the approved recovery copy and opens the terminal', () => {
    const onShowTerminal = vi.fn()
    render(<NativeChatDeliveryRecoveryNotice onShowTerminal={onShowTerminal} />)

    expect(screen.getByText('Message wasn’t sent')).toBeTruthy()
    expect(
      screen.getByText(
        'The terminal may be waiting for input. Your message is still in the composer.'
      )
    ).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show terminal' }))
    expect(onShowTerminal).toHaveBeenCalledOnce()
  })
})
