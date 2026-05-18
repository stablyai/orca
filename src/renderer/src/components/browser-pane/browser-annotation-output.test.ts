import { describe, expect, it } from 'vitest'
import type { BrowserPageAnnotation } from '../../../../shared/browser-grab-types'
import { formatBrowserAnnotationsAsMarkdown } from './browser-annotation-output'

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
  it('includes agent-useful selectors, source, react tree, styles, and feedback', () => {
    const markdown = formatBrowserAnnotationsAsMarkdown([makeAnnotation()])

    expect(markdown).toContain('## Design Feedback: /pricing')
    expect(markdown).toContain('**Browser tab id:** page-1')
    expect(markdown).toContain('**Orca CLI:** Use `--page page-1` to target this browser tab.')
    expect(markdown).not.toContain('Page Feedback')
    expect(markdown).toContain('**Selector:** `main.pricing > button.primary`')
    expect(markdown).toContain('**Source:** src/components/PricingCta.tsx:42:8')
    expect(markdown).toContain('**React:** <App> <PricingCta>')
    expect(markdown).toContain('**Intent:** change')
    expect(markdown).toContain('**Priority:** important')
    expect(markdown).toContain('- font-size: 16px')
    expect(markdown).toContain('**Feedback:** Make this primary action more obvious.')
  })

  it('returns an empty string when no annotations exist', () => {
    expect(formatBrowserAnnotationsAsMarkdown([])).toBe('')
  })

  it('uses longer inline code fences when selector content contains backticks', () => {
    const annotation = makeAnnotation()
    const markdown = formatBrowserAnnotationsAsMarkdown([
      makeAnnotation({
        payload: {
          ...annotation.payload,
          target: {
            ...annotation.payload.target,
            selector: 'button[data-label="Save `draft`"]',
            cssClasses: 'primary `generated`'
          }
        }
      })
    ])

    expect(markdown).toContain('**Selector:** ``button[data-label="Save `draft`"]``')
    expect(markdown).toContain('**Classes:** `` primary `generated` ``')
  })

  it('collapses page-controlled newlines before putting text in headings and lists', () => {
    const annotation = makeAnnotation()
    const markdown = formatBrowserAnnotationsAsMarkdown([
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
    ])

    expect(markdown).toContain('### 1. <App> <PricingCta> button "Start ## injected heading"')
    expect(markdown).toContain('- Plan # injected')
    expect(markdown).toContain('**Feedback:** Keep this change scoped. ## injected')
    expect(markdown).not.toContain('\n## injected')
  })
})
