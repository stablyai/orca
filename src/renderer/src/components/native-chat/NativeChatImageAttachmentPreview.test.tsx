// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'
import type { NativeChatComposerImageAttachment } from './NativeChatComposerField'

const mocks = vi.hoisted(() => ({
  useLocalImageSrc: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/components/editor/useLocalImageSrc', () => ({
  useLocalImageSrc: mocks.useLocalImageSrc
}))

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  mocks.useLocalImageSrc.mockReset()
})

function renderPreview(attachment: NativeChatComposerImageAttachment): void {
  vi.stubGlobal('IntersectionObserver', undefined)
  render(<NativeChatImageAttachmentPreview attachment={attachment} onRemove={vi.fn()} />)
}

describe('NativeChatImageAttachmentPreview', () => {
  it('shows the clipboard thumbnail and a spinner while pending', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', previewUrl: 'blob:clipboard-1', pending: true })

    expect(document.querySelector('.animate-spin')).toBeTruthy()
    expect(screen.getByRole('img', { name: 'Saving pasted image…' }).getAttribute('src')).toBe(
      'blob:clipboard-1'
    )
  })

  it('renders no spinner once the attachment has settled', () => {
    mocks.useLocalImageSrc.mockReturnValue('blob:on-disk-1')
    renderPreview({ id: 'a1', path: '/tmp/example.png' })

    expect(document.querySelector('.animate-spin')).toBeFalsy()
  })

  it('does not read the on-disk file while the attachment is pending', () => {
    mocks.useLocalImageSrc.mockReturnValue(undefined)
    renderPreview({ id: 'a1', path: '', previewUrl: 'blob:clipboard-1', pending: true })

    expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(undefined, '', undefined)
  })
})

it('uses the captured full-size image without reading an identically named local file', () => {
  vi.stubGlobal('IntersectionObserver', undefined)
  render(
    <NativeChatImageAttachmentPreview
      attachment={{ id: 'runtime', path: '/tmp/remote.png' }}
      fullSizePreviewUrl="data:image/png;base64,captured"
      onRemove={vi.fn()}
    />
  )
  expect(mocks.useLocalImageSrc).toHaveBeenCalledWith(undefined, '/tmp/remote.png', undefined)
  fireEvent.click(screen.getByRole('button', { name: 'View image: remote.png' }))
  expect(
    screen
      .getAllByRole('img')
      .every((image) => image.getAttribute('src') === 'data:image/png;base64,captured')
  ).toBe(true)
})
