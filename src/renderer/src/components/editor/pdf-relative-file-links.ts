import type { PDFPageProxy } from 'pdfjs-dist'

type PdfLinkAnnotation = {
  id?: string
  subtype?: string
  url?: string
  unsafeUrl?: string
  dest?: unknown
}

export type AnnotationLayerRenderedEvent = {
  source: { div: HTMLElement; pdfPage?: Pick<PDFPageProxy, 'getAnnotations'> | null }
}

type PdfEventBus = {
  on: (name: string, listener: (evt: AnnotationLayerRenderedEvent) => void) => void
  off: (name: string, listener: (evt: AnnotationLayerRenderedEvent) => void) => void
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/**
 * The href of a link to a file beside the PDF (a /GoToR or /Launch action), or
 * null for every link pdf.js already handles.
 */
export function getPdfRelativeFileLinkHref(annotation: PdfLinkAnnotation): string | null {
  if (annotation.subtype !== 'Link' || annotation.url || annotation.dest || !annotation.unsafeUrl) {
    return null
  }
  // Why: the fragment is a destination inside the target PDF, which the opener
  // cannot honor; left in, it would be read as part of the file name.
  const [path] = annotation.unsafeUrl.split('#', 1)
  // Why: only paths relative to the PDF. A scheme or an absolute path is a
  // document choosing a file on the reader's machine.
  if (!path || URL_SCHEME.test(path) || path.startsWith('/') || path.startsWith('\\')) {
    return null
  }
  return path.split('/').map(encodeURIComponent).join('/')
}

/**
 * Why: pdf.js binds a link only when it can make an absolute http(s)/mailto URL
 * from it, so a relative file link is drawn as an inert box. This wires those
 * boxes to `onOpen` each time a page's annotation layer is (re)built.
 */
export function attachPdfRelativeFileLinks(
  eventBus: PdfEventBus,
  onOpen: (href: string) => void
): () => void {
  const handleLayerRendered = ({ source }: AnnotationLayerRenderedEvent): void => {
    void source.pdfPage
      ?.getAnnotations()
      .then((annotations: PdfLinkAnnotation[]) => {
        for (const annotation of annotations) {
          const href = getPdfRelativeFileLinkHref(annotation)
          if (!href || !annotation.id) {
            continue
          }
          const section = source.div.querySelector<HTMLElement>(
            `section[data-annotation-id="${CSS.escape(annotation.id)}"]`
          )
          if (!section) {
            continue
          }
          section.setAttribute('role', 'link')
          section.tabIndex = 0
          section.title = decodeURIComponent(href)
          section.style.cursor = 'pointer'
          section.onclick = () => onOpen(href)
          section.onkeydown = (event) => {
            if (event.key === 'Enter') {
              onOpen(href)
            }
          }
        }
      })
      .catch(() => {})
  }
  eventBus.on('annotationlayerrendered', handleLayerRendered)
  return () => eventBus.off('annotationlayerrendered', handleLayerRendered)
}
