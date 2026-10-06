// @vitest-environment happy-dom

import { describe, expect, it, vi } from 'vitest'
import {
  attachPdfRelativeFileLinks,
  getPdfRelativeFileLinkHref,
  type AnnotationLayerRenderedEvent
} from './pdf-relative-file-links'

// What pdf.js 6 reports for hyperref's /GoToR link to a sibling PDF.
const goToRemote = {
  id: '12R',
  subtype: 'Link',
  unsafeUrl: '../papers/example2024.pdf#[0,{"name":"Fit"}]'
}

describe('getPdfRelativeFileLinkHref', () => {
  it('returns the relative path without the destination fragment', () => {
    expect(getPdfRelativeFileLinkHref(goToRemote)).toBe('../papers/example2024.pdf')
  })

  it('escapes characters a URL would read as syntax', () => {
    expect(getPdfRelativeFileLinkHref({ subtype: 'Link', unsafeUrl: 'papers/a b?c%20.pdf' })).toBe(
      'papers/a%20b%3Fc%2520.pdf'
    )
  })

  it.each([
    ['a link pdf.js resolved', { subtype: 'Link', url: 'https://a.test/', unsafeUrl: 'x.pdf' }],
    ['an internal destination', { subtype: 'Link', dest: 'cite.key', unsafeUrl: 'x.pdf' }],
    ['a scheme', { subtype: 'Link', unsafeUrl: 'file:///etc/passwd' }],
    ['a Windows drive', { subtype: 'Link', unsafeUrl: 'C:/Users/a/x.pdf' }],
    ['an absolute path', { subtype: 'Link', unsafeUrl: '/etc/passwd' }],
    ['a UNC path', { subtype: 'Link', unsafeUrl: '\\\\host\\share\\x.pdf' }],
    ['a non-link annotation', { subtype: 'Widget', unsafeUrl: 'x.pdf' }]
  ])('ignores %s', (_name, annotation) => {
    expect(getPdfRelativeFileLinkHref(annotation)).toBeNull()
  })
})

describe('attachPdfRelativeFileLinks', () => {
  function renderPage(): {
    emit: () => Promise<void>
    detach: () => void
    onOpen: ReturnType<typeof vi.fn<(href: string) => void>>
    fileLink: HTMLElement
    citeLink: HTMLElement
  } {
    const div = document.createElement('div')
    const fileLink = document.createElement('section')
    fileLink.dataset.annotationId = '12R'
    const citeLink = document.createElement('section')
    citeLink.dataset.annotationId = '13R'
    div.append(fileLink, citeLink)
    const listeners = new Map<string, (evt: AnnotationLayerRenderedEvent) => void>()
    const onOpen = vi.fn<(href: string) => void>()
    const detach = attachPdfRelativeFileLinks(
      {
        on: (name, listener) => listeners.set(name, listener),
        off: (name) => listeners.delete(name)
      },
      onOpen
    )
    const getAnnotations = async () => [
      goToRemote,
      { id: '13R', subtype: 'Link', dest: 'cite.other' }
    ]
    return {
      emit: async () => {
        listeners.get('annotationlayerrendered')?.({ source: { div, pdfPage: { getAnnotations } } })
        await Promise.resolve()
        await Promise.resolve()
      },
      detach,
      onOpen,
      fileLink,
      citeLink
    }
  }

  it('opens the linked file on click and on Enter, and leaves other links alone', async () => {
    const page = renderPage()
    await page.emit()

    page.fileLink.click()
    page.fileLink.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    page.citeLink.click()

    expect(page.onOpen.mock.calls).toEqual([
      ['../papers/example2024.pdf'],
      ['../papers/example2024.pdf']
    ])
    expect(page.fileLink.getAttribute('role')).toBe('link')
    expect(page.citeLink.getAttribute('role')).toBeNull()
  })

  it('stops wiring pages rendered after detach', async () => {
    const page = renderPage()
    page.detach()
    await page.emit()

    page.fileLink.click()

    expect(page.onOpen).not.toHaveBeenCalled()
  })
})
