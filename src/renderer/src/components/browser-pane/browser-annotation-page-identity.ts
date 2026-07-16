import type { BrowserPageAnnotation } from '../../../../shared/browser-grab-types'

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:', 'file:'])

export type BrowserAnnotationMarker = {
  id: string
  index: number
  isFixed: boolean
  rectPage: BrowserPageAnnotation['payload']['target']['rectPage']
  rectViewport: BrowserPageAnnotation['payload']['target']['rectViewport']
}

function documentKey(rawUrl: string): string | null {
  if (!rawUrl) {
    return null
  }
  if (rawUrl === 'about:blank') {
    return 'about:blank'
  }
  try {
    const url = new URL(rawUrl)
    if (!SUPPORTED_PROTOCOLS.has(url.protocol)) {
      return null
    }
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

export function browserAnnotationDocumentKey(annotation: BrowserPageAnnotation): string | null {
  return documentKey(annotation.payload.page.sanitizedUrl)
}

export function isBrowserAnnotationOnDocument(
  annotation: BrowserPageAnnotation,
  activeUrl: string
): boolean {
  const capturedKey = browserAnnotationDocumentKey(annotation)
  const activeKey = documentKey(activeUrl)
  return capturedKey !== null && activeKey !== null && capturedKey === activeKey
}

export function selectBrowserAnnotationMarkers(
  annotations: BrowserPageAnnotation[],
  activeUrl: string
): BrowserAnnotationMarker[] {
  return annotations.flatMap((annotation, index) =>
    isBrowserAnnotationOnDocument(annotation, activeUrl)
      ? [
          {
            id: annotation.id,
            index,
            isFixed: annotation.payload.target.isFixed === true,
            rectPage: annotation.payload.target.rectPage,
            rectViewport: annotation.payload.target.rectViewport
          }
        ]
      : []
  )
}

export function groupBrowserAnnotationsByDocument(
  annotations: BrowserPageAnnotation[]
): BrowserPageAnnotation[][] {
  const groups = new Map<string, BrowserPageAnnotation[]>()
  for (const annotation of annotations) {
    const key = browserAnnotationDocumentKey(annotation) ?? ''
    const group = groups.get(key)
    if (group) {
      group.push(annotation)
    } else {
      groups.set(key, [annotation])
    }
  }
  return [...groups.values()]
}
