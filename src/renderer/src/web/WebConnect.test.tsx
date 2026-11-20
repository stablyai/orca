// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebConnect from './pairing/WebConnect'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('./web-device-key-support', () => ({ readWebDeviceKeySupport: () => null }))

afterEach(cleanup)

describe('WebConnect', () => {
  it('disables autocapitalization on the pairing field', () => {
    render(<WebConnect initialPairingInput={null} onConnected={() => {}} />)
    const input = screen.getByLabelText('Pairing URL or code')
    // Why: the payload is case-sensitive base64url; iPadOS capitalizes the first
    // character of a field that never received typed input, corrupting the paste.
    expect(input).toHaveAttribute('autocapitalize', 'none')
    expect(input).toHaveAttribute('autocorrect', 'off')
  })
})
