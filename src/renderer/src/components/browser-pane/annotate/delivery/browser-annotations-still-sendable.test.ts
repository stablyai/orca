import { describe, expect, it } from 'vitest'
import type { BrowserPageAnnotation } from '../../../../../../shared/browser/element-grab/browser-grab-types'
import { holdNotesForSend } from '@/components/notes/delivery/notes-send-in-flight'
import { browserAnnotationsStillSendable } from './use-browser-page-annotation-send'

const RECT = { x: 10, y: 10, width: 100, height: 28 }
const STYLES = {
  display: 'block',
  position: 'static',
  width: '100px',
  height: '28px',
  margin: '0px',
  padding: '0px',
  color: 'rgb(0, 0, 0)',
  backgroundColor: 'rgba(0, 0, 0, 0)',
  border: '0px none',
  borderRadius: '0px',
  fontFamily: 'serif',
  fontSize: '32px',
  fontWeight: '700',
  lineHeight: 'normal',
  textAlign: 'start',
  zIndex: 'auto'
}

function annotation(comment: string): BrowserPageAnnotation {
  return {
    id: 'sample-annotation',
    browserPageId: 'sample-page',
    comment,
    intent: 'change',
    priority: 'suggestion',
    createdAt: '2026-01-01T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: 'http://127.0.0.1/',
        title: 'Sample Report',
        viewportWidth: 800,
        viewportHeight: 600,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 1,
        capturedAt: '2026-01-01T00:00:00.000Z'
      },
      target: {
        tagName: 'h1',
        selector: 'h1',
        textSnippet: 'Sample Report',
        htmlSnippet: '<h1>Sample Report</h1>',
        attributes: {},
        accessibility: {
          role: 'heading',
          accessibleName: 'Sample Report',
          ariaLabel: null,
          ariaLabelledBy: null
        },
        rectViewport: RECT,
        rectPage: RECT,
        computedStyles: STYLES
      },
      nearbyText: [],
      ancestorPath: [],
      screenshot: null
    }
  }
}

function state(activePageId: string, annotations: BrowserPageAnnotation[]) {
  return {
    browserTabsByWorktree: { 'sample-workspace': [{ activePageId }] },
    browserAnnotationsByPageId: { 'sample-page': annotations }
  }
}

describe('browser annotations still sendable', () => {
  it('lets an unchanged prompt go from its active page', () => {
    const original = annotation('Sample feedback')
    expect(
      browserAnnotationsStillSendable(
        state('sample-page', [original]),
        'sample-workspace',
        'sample-page',
        [original]
      )
    ).toBe(true)
  })

  it('refuses a prompt built before an edit', () => {
    const original = annotation('Sample feedback')
    const edited = annotation('Edited sample feedback')
    expect(
      browserAnnotationsStillSendable(
        state('sample-page', [edited]),
        'sample-workspace',
        'sample-page',
        [original]
      )
    ).toBe(false)
  })

  it('refuses once another page is showing, even if the annotated page stays mounted', () => {
    const original = annotation('Sample feedback')
    expect(
      browserAnnotationsStillSendable(
        state('other-page', [original]),
        'sample-workspace',
        'sample-page',
        [original]
      )
    ).toBe(false)
    expect(
      browserAnnotationsStillSendable(
        state('sample-page', [original]),
        'other-workspace',
        'sample-page',
        [original]
      )
    ).toBe(false)
  })

  it('refuses annotations another send already holds', () => {
    const original = annotation('Sample feedback')
    const pending = Promise.withResolvers<void>()
    holdNotesForSend([original], pending.promise)
    try {
      expect(
        browserAnnotationsStillSendable(
          state('sample-page', [original]),
          'sample-workspace',
          'sample-page',
          [original]
        )
      ).toBe(false)
    } finally {
      pending.resolve()
    }
  })
})
