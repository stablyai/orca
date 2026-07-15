import { describe, expect, it } from 'vitest'
import type { BrowserPageAnnotation } from '../../../../shared/browser-grab-types'
import {
  browserAnnotationDocumentKey,
  groupBrowserAnnotationsByDocument,
  isBrowserAnnotationOnDocument,
  selectBrowserAnnotationMarkers
} from './browser-annotation-page-identity'

function annotation(id: string, url: string): BrowserPageAnnotation {
  return {
    id,
    browserPageId: 'page-1',
    comment: 'comment',
    intent: 'change',
    priority: 'important',
    createdAt: '2026-01-01T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: url,
        title: 'Page',
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        capturedAt: '2026-01-01T00:00:00.000Z'
      },
      target: {
        tagName: 'button',
        selector: '#button',
        textSnippet: id,
        htmlSnippet: '<button />',
        attributes: {},
        accessibility: {
          role: 'button',
          accessibleName: id,
          ariaLabel: null,
          ariaLabelledBy: null
        },
        rectViewport: { x: 1, y: 2, width: 3, height: 4 },
        rectPage: { x: 5, y: 6, width: 7, height: 8 },
        computedStyles: {
          display: 'block',
          position: 'static',
          width: '3px',
          height: '4px',
          margin: '0',
          padding: '0',
          color: 'black',
          backgroundColor: 'white',
          border: '0',
          borderRadius: '0',
          fontFamily: 'sans-serif',
          fontSize: '16px',
          fontWeight: '400',
          lineHeight: 'normal',
          textAlign: 'left',
          zIndex: 'auto'
        }
      },
      nearbyText: [],
      ancestorPath: [],
      screenshot: null
    }
  }
}

describe('browser annotation document identity', () => {
  it('matches query and fragment changes but filters a different page', () => {
    const current = annotation('current', 'https://example.com/docs?token=redacted#section')
    expect(isBrowserAnnotationOnDocument(current, 'https://example.com/docs?other=1#new')).toBe(
      true
    )
    expect(isBrowserAnnotationOnDocument(current, 'https://example.com/settings')).toBe(false)
  })

  it('preserves full-queue indexes and restores markers when navigating back', () => {
    const annotations = [
      annotation('a', 'https://example.com/a'),
      annotation('b', 'https://example.com/b'),
      annotation('a-2', 'https://example.com/a')
    ]
    expect(selectBrowserAnnotationMarkers(annotations, 'https://example.com/b')).toEqual([
      expect.objectContaining({ id: 'b', index: 1 })
    ])
    expect(selectBrowserAnnotationMarkers(annotations, 'https://example.com/a')).toEqual([
      expect.objectContaining({ id: 'a', index: 0 }),
      expect.objectContaining({ id: 'a-2', index: 2 })
    ])
  })

  it('fails closed for invalid live URLs and groups empty captured keys in first appearance order', () => {
    const empty = annotation('empty', '')
    const first = annotation('first', 'https://example.com/a')
    const second = annotation('second', 'https://example.com/b')
    expect(selectBrowserAnnotationMarkers([first], 'javascript:alert(1)')).toEqual([])
    expect(
      groupBrowserAnnotationsByDocument([
        empty,
        first,
        second,
        annotation('empty-2', ''),
        annotation('third', 'https://example.com/a')
      ]).map((group) => group.map(({ id }) => id))
    ).toEqual([['empty', 'empty-2'], ['first', 'third'], ['second']])
  })

  it('matches about:blank and rejects empty captured keys', () => {
    expect(browserAnnotationDocumentKey(annotation('blank', 'about:blank'))).toBe('about:blank')
    expect(browserAnnotationDocumentKey(annotation('empty', ''))).toBeNull()
  })
})
