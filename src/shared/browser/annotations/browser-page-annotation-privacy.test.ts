import { expect, it } from 'vitest'
import { browserPageAnnotationSchema } from './browser-page-annotation-schema'
import type { BrowserPageAnnotation } from '../element-grab/browser-grab-types'

function makeAnnotation(pageId: string, id = 'annotation-1'): BrowserPageAnnotation {
  return {
    id,
    browserPageId: pageId,
    comment: 'Fix this button',
    intent: 'fix',
    priority: 'important',
    createdAt: '2026-05-15T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: 'https://example.com',
        title: 'Example',
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        capturedAt: '2026-05-15T00:00:00.000Z'
      },
      target: {
        tagName: 'button',
        selector: 'button',
        textSnippet: 'Submit',
        htmlSnippet: '<button>Submit</button>',
        attributes: {},
        accessibility: {
          role: 'button',
          accessibleName: 'Submit',
          ariaLabel: null,
          ariaLabelledBy: null
        },
        rectViewport: { x: 0, y: 0, width: 100, height: 40 },
        rectPage: { x: 0, y: 0, width: 100, height: 40 },
        computedStyles: {
          display: 'inline-flex',
          position: 'static',
          width: '100px',
          height: '40px',
          margin: '0px',
          padding: '0px',
          color: 'rgb(0, 0, 0)',
          backgroundColor: 'rgba(0, 0, 0, 0)',
          border: '0px none',
          borderRadius: '0px',
          fontFamily: 'Geist',
          fontSize: '14px',
          fontWeight: '400',
          lineHeight: '20px',
          textAlign: 'center',
          zIndex: 'auto'
        }
      },
      nearbyText: [],
      ancestorPath: [],
      screenshot: null
    }
  }
}

it.each([
  ['https://kagi.com/search?token=annotation-secret&q=one', 'https://kagi.com/search?q=one'],
  ['https://example.com/?token=ordinary', 'https://example.com/?token=ordinary']
])('scrubs legacy annotation page metadata before session restore or save: %s', (raw, safe) => {
  const annotation = makeAnnotation('page')
  annotation.payload.page.sanitizedUrl = raw
  annotation.payload.page.title = raw
  annotation.comment = raw
  const restored = browserPageAnnotationSchema.parse(annotation)
  expect(restored.payload.page.sanitizedUrl).toBe(safe)
  expect(restored.payload.page.title).toBe(safe)
  expect(restored.comment).toBe(raw)
})
