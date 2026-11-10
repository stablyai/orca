import { describe, expect, it } from 'vitest'
import type { BrowserPageAnnotation } from '../../../../../shared/browser/element-grab/browser-grab-types'
import {
  BROWSER_ANNOTATION_INLINE_TEXT_MAX_LENGTH,
  formatBrowserAnnotationsAsMarkdown
} from './browser-annotation-output'

function makeAnnotation(overrides?: Partial<BrowserPageAnnotation>): BrowserPageAnnotation {
  return {
    id: 'annotation-1',
    browserPageId: 'page-1',
    comment: 'Make this primary action more obvious.',
    intent: 'change',
    priority: 'important',
    createdAt: '2026-05-15T00:00:00.000Z',
    payload: {
      page: {
        sanitizedUrl: 'https://example.com/pricing',
        title: 'Pricing - Example',
        viewportWidth: 1280,
        viewportHeight: 720,
        scrollX: 0,
        scrollY: 0,
        devicePixelRatio: 2,
        capturedAt: '2026-05-15T00:00:00.000Z'
      },
      target: {
        tagName: 'button',
        selector: 'main.pricing > button.primary',
        elementPath: 'main > .pricing > button',
        fullPath: 'html > body > main.pricing > button.primary',
        cssClasses: 'primary',
        nearbyElements: ['span "$29/month"'],
        selectedText: null,
        isFixed: false,
        reactComponents: '<App> <PricingCta>',
        sourceFile: 'src/components/PricingCta.tsx:42:8',
        textSnippet: 'Start free trial',
        htmlSnippet: '<button class="primary">Start free trial</button>',
        attributes: { class: 'primary', type: 'button' },
        accessibility: {
          role: 'button',
          accessibleName: 'Start free trial',
          ariaLabel: null,
          ariaLabelledBy: null
        },
        rectViewport: { x: 400, y: 300, width: 148, height: 44 },
        rectPage: { x: 400, y: 300, width: 148, height: 44 },
        computedStyles: {
          display: 'inline-flex',
          position: 'relative',
          width: '148px',
          height: '44px',
          margin: '0px',
          padding: '12px 24px',
          color: 'rgb(255, 255, 255)',
          backgroundColor: 'rgb(99, 102, 241)',
          border: '0px none',
          borderRadius: '8px',
          fontFamily: 'Geist, sans-serif',
          fontSize: '16px',
          fontWeight: '600',
          lineHeight: '20px',
          textAlign: 'center',
          zIndex: 'auto'
        }
      },
      nearbyText: ['Pro', '$29/month'],
      ancestorPath: ['section', 'main', 'body'],
      screenshot: null
    },
    ...overrides
  }
}

describe('formatBrowserAnnotationsAsMarkdown', () => {
  it('collapses page-controlled newlines before putting text in headings and lists', () => {
    const annotation = makeAnnotation()
    const markdown = formatBrowserAnnotationsAsMarkdown(
      [
        makeAnnotation({
          comment: 'Keep this change scoped.\n## injected',
          payload: {
            ...annotation.payload,
            target: {
              ...annotation.payload.target,
              accessibility: {
                ...annotation.payload.target.accessibility,
                accessibleName: 'Start\n## injected heading'
              },
              textSnippet: 'Start\n## injected text'
            },
            nearbyText: ['Plan\n# injected']
          }
        })
      ],
      { includeDiagnostics: true }
    )

    expect(markdown).toContain('### 1. <App> <PricingCta> button "Start ## injected heading"')
    expect(markdown).toContain('- Plan # injected')
    expect(markdown).toContain('**Feedback:** Keep this change scoped. ## injected')
    expect(markdown).not.toContain('\n## injected')
  })

  it('does not split surrogate pairs at the inline annotation cap', () => {
    const annotation = makeAnnotation()
    const selectedText = `${'x'.repeat(BROWSER_ANNOTATION_INLINE_TEXT_MAX_LENGTH - 1)}😀tail`

    const markdown = formatBrowserAnnotationsAsMarkdown([
      makeAnnotation({
        payload: {
          ...annotation.payload,
          target: {
            ...annotation.payload.target,
            selectedText
          }
        }
      })
    ])

    const selectedLabel = '**Selected text:**'
    const selectedLineStart = markdown.indexOf(selectedLabel)
    const selectedLineEnd = markdown.indexOf('\n', selectedLineStart)
    const selectedLine = markdown.slice(
      selectedLineStart,
      selectedLineEnd === -1 ? markdown.length : selectedLineEnd
    )

    expect(selectedLineStart).not.toBe(-1)
    expect(selectedLine).toBe(`**Selected text:** "${'x'.repeat(2047)}"`)
    expect(selectedLine).not.toContain('😀')
    expect(selectedLine).not.toContain('tail')
    expect(selectedLine).not.toContain('\ufffd')
  })
})
