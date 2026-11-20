// @vitest-environment happy-dom
import { AnnotationMode } from 'pdfjs-dist'
import type * as pdfjsLib from 'pdfjs-dist'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPdfViewerSession } from './pdf-viewer-session'

const constructed = vi.hoisted((): Record<string, unknown>[] => [])

vi.mock('pdfjs-dist/web/pdf_viewer.mjs', () => {
  class EventBus {
    on(): void {}
    off(): void {}
  }
  class PDFLinkService {
    setViewer(): void {}
    setDocument(): void {}
  }
  class PDFFindController {
    setDocument(): void {}
  }
  class PDFViewer {
    currentScale = 1
    currentScaleValue = 'page-width'
    pagesCount = 0
    constructor(options: Record<string, unknown>) {
      constructed.push(options)
    }
    setDocument(): void {}
    getPageView(): null {
      return null
    }
    scrollPageIntoView(): void {}
    update(): void {}
  }
  return { EventBus, PDFFindController, PDFLinkService, PDFViewer }
})

afterEach(() => {
  constructed.length = 0
})

describe('createPdfViewerSession', () => {
  it('keeps AcroForm appearances visible without editable widgets', () => {
    const container = document.createElement('div')
    const viewerDiv = document.createElement('div')
    const session = createPdfViewerSession({
      container,
      viewerDiv,
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the viewer mock never reads the document.
      doc: {} as pdfjsLib.PDFDocumentProxy,
      scrollCacheKey: null,
      getScalePreference: () => 'page-width',
      scaleBounds: { min: 0.25, max: 5 },
      onScaleChanging: () => {},
      onWheelZoom: () => {}
    })
    try {
      expect(constructed).toHaveLength(1)
      expect(constructed[0]?.annotationMode).toBe(AnnotationMode.ENABLE)
    } finally {
      session.dispose()
    }
  })
})
