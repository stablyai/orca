// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MobilePairingQrSection } from './MobilePairingQrSection'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

afterEach(cleanup)

describe('MobilePairingQrSection', () => {
  it('moves focus to the copy action when a pairing code becomes ready', () => {
    const props = {
      qrDataUrl: null,
      qrError: false,
      pairingUrl: null,
      endpoint: null,
      qrEnlarged: false,
      codeCopied: false,
      onQrEnlargedChange: vi.fn(),
      onCodeCopiedChange: vi.fn(),
      onClearCodeCopiedTimer: vi.fn()
    }
    const { rerender } = render(<MobilePairingQrSection {...props} />)

    rerender(
      <MobilePairingQrSection
        {...props}
        qrDataUrl="data:image/png;base64,qr"
        pairingUrl="orca://pair#ready"
      />
    )

    expect(screen.getByRole('button', { name: 'Copy pairing code' })).toHaveFocus()
  })

  it('does not steal focus from a control that remains mounted', () => {
    const props = {
      qrDataUrl: null,
      qrError: false,
      pairingUrl: null,
      endpoint: null,
      qrEnlarged: false,
      codeCopied: false,
      onQrEnlargedChange: vi.fn(),
      onCodeCopiedChange: vi.fn(),
      onClearCodeCopiedTimer: vi.fn()
    }
    const { rerender } = render(
      <>
        <button type="button">Persistent action</button>
        <MobilePairingQrSection {...props} />
      </>
    )
    const persistentAction = screen.getByRole('button', { name: 'Persistent action' })
    persistentAction.focus()

    rerender(
      <>
        <button type="button">Persistent action</button>
        <MobilePairingQrSection
          {...props}
          qrDataUrl="data:image/png;base64,qr"
          pairingUrl="orca://pair#ready"
        />
      </>
    )

    expect(persistentAction).toHaveFocus()
  })
})
