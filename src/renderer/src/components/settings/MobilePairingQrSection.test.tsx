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
    await userEvent.click(screen.getByRole('button', { name: 'Copy pairing code' }))
    expect(writeClipboardText).toHaveBeenCalledWith('orca://pair?code=copy-fallback')
  })

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

  it('keeps the QR on integer CSS scaling at normal and enlarged sizes', () => {
    render(
      <MobilePairingQrSection
        qrDataUrl="data:image/png;base64,qr"
        qrSize={218}
        qrError={false}
        pairingUrl="orca://pair#ready"
        endpoint={null}
        qrEnlarged
        codeCopied={false}
        onQrEnlargedChange={vi.fn()}
        onCodeCopiedChange={vi.fn()}
        onClearCodeCopiedTimer={vi.fn()}
      />
    )

    const images = Array.from(
      document.querySelectorAll<HTMLImageElement>('img[alt="QR Code for mobile pairing"]')
    )
    expect(images.map((image) => image.style.width).sort()).toEqual(['218px', '436px'])
    expect(images.map((image) => image.style.height).sort()).toEqual(['218px', '436px'])
    expect(images.every((image) => image.style.imageRendering === 'pixelated')).toBe(true)
  })
})
