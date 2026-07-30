// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobilePairingQrSection } from './MobilePairingQrSection'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

describe('MobilePairingQrSection', () => {
  it('shows and copies the pairing URL when QR encoding fails', async () => {
    const writeClipboardText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ui: { writeClipboardText } }
    })
    render(
      <MobilePairingQrSection
        qrDataUrl={null}
        qrError
        pairingUrl="orca://pair?code=copy-fallback"
        endpoint="wss://host.example/large"
        qrEnlarged={false}
        codeCopied={false}
        onQrEnlargedChange={vi.fn()}
        onCodeCopiedChange={vi.fn()}
        onClearCodeCopiedTimer={vi.fn()}
      />
    )

    expect(screen.getByRole('alert')).toHaveTextContent('couldn’t be rendered as a QR code')
    await userEvent.click(screen.getByRole('button', { name: /copy-fallback/ }))
    expect(writeClipboardText).toHaveBeenCalledWith('orca://pair?code=copy-fallback')
  })
})
