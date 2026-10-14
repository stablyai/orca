// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ChatAddressPreviewEntry } from '../../../../shared/chat-address-preview'
import { NativeChatAddressPreviews } from './NativeChatAddressPreviews'
import NativeChatAddressPreviewMarkdown from './NativeChatAddressPreviewMarkdown'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, string>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => options?.[name] ?? '')
}))

const actions = {
  onDismiss: vi.fn(),
  onRetry: vi.fn(),
  onAllowPrivateNetwork: vi.fn()
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('NativeChatAddressPreviews', () => {
  it('does not expose credentials from an unrecognized backend error', () => {
    const { container } = render(
      <NativeChatAddressPreviews
        entries={[
          {
            id: 'error',
            source: 'https://example.com/file',
            result: {
              status: 'error',
              id: 'error',
              message: 'Connection refused for https://alice:password@example.com/file?token=secret'
            }
          }
        ]}
        {...actions}
      />
    )
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(container.innerHTML).not.toMatch(/alice|password|token=secret/)
  })

  it('hides URL credentials and signed query strings without modifying the source', () => {
    const source = 'https://alice:password@example.com/report.pdf?token=secret#private'
    const entry: ChatAddressPreviewEntry = { id: 'one', source, result: null }
    const { container } = render(<NativeChatAddressPreviews entries={[entry]} {...actions} />)

    expect(screen.getByText('https://example.com/report.pdf')).toBeTruthy()
    expect(container.innerHTML).not.toMatch(/alice|password|token=secret|#private/)
  })

  it('expands an image and shows file metadata', () => {
    render(
      <NativeChatAddressPreviews
        entries={[
          {
            id: 'image',
            source: '/tmp/photo.png',
            result: {
              status: 'ready',
              id: 'image',
              name: 'photo.png',
              kind: 'image',
              mimeType: 'image/png',
              size: 1024,
              url: 'blob:photo'
            }
          }
        ]}
        {...actions}
      />
    )
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: photo.png' }))
    expect(
      within(screen.getByRole('dialog')).getByRole('img', { name: 'photo.png' }).getAttribute('src')
    ).toBe('blob:photo')
  })

  it('reads literal text without treating it as HTML', () => {
    render(
      <NativeChatAddressPreviews
        entries={[
          {
            id: 'text',
            source: '/tmp/readme.txt',
            result: {
              status: 'ready',
              id: 'text',
              name: 'readme.txt',
              kind: 'text',
              mimeType: 'text/plain',
              content: '<img src="https://example.com/tracker">'
            }
          }
        ]}
        {...actions}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Open preview: readme.txt' }))
    const dialog = screen.getByRole('dialog')
    expect(dialog.querySelector('code')?.textContent).toBe(
      '<img src="https://example.com/tracker">'
    )
    expect(dialog.querySelector('img')).toBeNull()
  })

  it.each(['audio', 'video'] as const)(
    'shows %s controls inline and unloads on source replacement and removal',
    (kind) => {
      const pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
      const load = vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {})
      const entry: ChatAddressPreviewEntry = {
        id: 'media',
        source: '/tmp/recording',
        result: {
          status: 'ready',
          id: 'media',
          name: 'recording',
          kind,
          mimeType: `${kind}/mpeg`,
          url: 'blob:recording'
        }
      }
      const { rerender, unmount } = render(
        <NativeChatAddressPreviews entries={[entry]} {...actions} />
      )
      expect(screen.queryByRole('button', { name: 'Open preview: recording' })).toBeNull()
      const player = document.querySelector(kind) as HTMLMediaElement
      expect(player.controls).toBe(true)
      expect(player.autoplay).toBe(false)
      expect(player.preload).toBe('metadata')

      rerender(
        <NativeChatAddressPreviews
          entries={[
            {
              ...entry,
              result: {
                ...entry.result!,
                status: 'ready',
                id: 'media',
                name: 'recording',
                kind,
                mimeType: `${kind}/mpeg`,
                url: 'blob:replacement'
              }
            }
          ]}
          {...actions}
        />
      )
      expect(player.hasAttribute('src')).toBe(false)
      expect(pause).toHaveBeenCalled()
      expect(load).toHaveBeenCalled()
      const replacement = document.querySelector(kind) as HTMLMediaElement
      expect(replacement).not.toBe(player)
      expect(replacement.getAttribute('src')).toBe('blob:replacement')
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      fireEvent.error(replacement)
      expect(document.querySelector(kind)).toBeNull()
      expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
      unmount()
      expect(replacement.hasAttribute('src')).toBe(false)
    }
  )
})

describe('NativeChatAddressPreviewMarkdown', () => {
  it('keeps readable Markdown without nested image, HTML, video, or app-link requests', () => {
    const { container } = render(
      <NativeChatAddressPreviewMarkdown
        content={[
          '# Readable document',
          '**Important text**',
          '![Remote](https://example.com/tracker.png)',
          '![Local](file:///tmp/private.png)',
          '<img src="https://example.com/raw.png" onerror="alert(1)">',
          '<video src="https://example.com/clip.mp4" autoplay></video>',
          '<iframe src="https://example.com/frame"></iframe>',
          '<script>alert(1)</script>',
          '[clip.mp4](https://github.com/user-attachments/assets/example.mp4)',
          '[Open app](orca://action)',
          '[Web link](https://example.com)'
        ].join('\n\n')}
      />
    )

    expect(screen.getByRole('heading', { name: 'Readable document' })).toBeTruthy()
    expect(container.querySelector('strong')?.textContent).toBe('Important text')
    expect(container.querySelector('img, video, audio, iframe, script, a[href], [src]')).toBeNull()
    expect(screen.getByText('Web link')).toBeTruthy()
    expect(screen.getByText('Open app')).toBeTruthy()
  })
})
