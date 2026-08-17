import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BrowserPageAnnotation } from '../../../../shared/browser-grab-types'
import {
  BROWSER_ANNOTATION_INLINE_TEXT_MAX_LENGTH,
  formatBrowserAnnotationsAsMarkdown
} from './browser-annotation-output'

afterEach(() => {
  vi.restoreAllMocks()
})

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
    expect(markdown).not.toContain('Orca CLI')
    expect(markdown).not.toContain('--page page-1')
    expect(markdown).not.toContain('Page Feedback')
    expect(markdown).toContain('**Selector:** `main.pricing > button.primary`')
    expect(markdown).toContain('**Source:** src/components/PricingCta.tsx:42:8')
    expect(markdown).toContain('**React:** <App> <PricingCta>')
    expect(markdown).toContain('**Intent:** change')
    expect(markdown).not.toContain('**Priority:**')
    expect(markdown).toContain('- font-size: 16px')
    expect(markdown).toContain('**Feedback:** Make this primary action more obvious.')
  })

  it('returns an empty string when no annotations exist', () => {
    expect(formatBrowserAnnotationsAsMarkdown([])).toBe('')
  })

  it('resolves reference tokens used in the feedback to selectors', () => {
    const markdown = formatBrowserAnnotationsAsMarkdown([
      makeAnnotation({
        comment: 'Move this button below @ref1 and match the width of @ref2.',
        references: [
          {
            index: 1,
            label: 'section "Plan comparison"',
            tagName: 'section',
            selector: 'main.pricing > section.compare',
            elementPath: 'main > .pricing > section',
            rectViewport: { x: 120, y: 640, width: 900, height: 320 },
            rectPage: { x: 120, y: 640, width: 900, height: 320 }
          },
          {
            index: 2,
            label: 'div "Enterprise"',
            tagName: 'div',
            selector: 'main.pricing > div.enterprise',
            rectViewport: { x: 900, y: 300, width: 240, height: 400 },
            rectPage: { x: 900, y: 300, width: 240, height: 400 }
          }
        ]
      })
    ])

    expect(markdown).toContain('**References:**')
    expect(markdown).toContain(
      '- @ref1 — section "Plan comparison" — `main.pricing > section.compare` — `main > .pricing > section` (at 120,640 900x320)'
    )
    expect(markdown).toContain(
      '- @ref2 — div "Enterprise" — `main.pricing > div.enterprise` (at 900,300 240x400)'
    )
    // Why: the block must precede the feedback line so the tokens are already
    // defined when the agent reads the sentence that uses them.
    expect(markdown.indexOf('**References:**')).toBeLessThan(markdown.indexOf('**Feedback:**'))
  })

  it('describes a point as a position inside its container, not as that container', () => {
    const markdown = formatBrowserAnnotationsAsMarkdown([
      makeAnnotation({
        comment: 'Drop a testimonial block at @ref1.',
        references: [
          {
            index: 1,
            label: 'spot at 640, 1820',
            // Why: a background pick still carries body as its hit element — the
            // output must not hand that selector to the agent as the target.
            tagName: 'body',
            selector: 'body',
            rectViewport: { x: 0, y: 0, width: 1280, height: 4000 },
            rectPage: { x: 0, y: 0, width: 1280, height: 4000 },
            point: {
              viewportX: 640,
              viewportY: 320,
              pageX: 640,
              pageY: 1820,
              offsetX: 520,
              offsetY: 256,
              ratioX: 0.5778,
              ratioY: 0.8,
              hostWidth: 900,
              hostHeight: 320,
              inEmptySpace: true
            }
          }
        ]
      })
    ])

    // The container is named as context, but explicitly not as the target.
    expect(markdown).toContain('empty space inside `body`, not an element')
    expect(markdown).toContain('58% across and 80% down that container')
    expect(markdown).toContain('offset x=520, y=256 within its 900x320 box')
    expect(markdown).toContain('page x=640, y=1820')
  })

  it('omits the references block for annotations without references', () => {
    expect(formatBrowserAnnotationsAsMarkdown([makeAnnotation()])).not.toContain('**References:**')
    expect(formatBrowserAnnotationsAsMarkdown([makeAnnotation({ references: [] })])).not.toContain(
      '**References:**'
    )
  })

  it('fences reference selectors that contain backticks', () => {
    const markdown = formatBrowserAnnotationsAsMarkdown([
      makeAnnotation({
        references: [
          {
            index: 1,
            label: 'button',
            tagName: 'button',
            selector: 'button[data-label="Save `draft`"]',
            rectViewport: { x: 0, y: 0, width: 10, height: 10 },
            rectPage: { x: 0, y: 0, width: 10, height: 10 }
          }
        ]
      })
    ])

    expect(markdown).toContain('``button[data-label="Save `draft`"]``')
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

  it('formats page snippets with many backtick runs', () => {
    const matchAll = vi.spyOn(String.prototype, 'matchAll')
    const annotation = makeAnnotation()
    const manyBacktickRuns = Array.from({ length: 130_000 }, () => '`').join(' ')

    expect(() =>
      formatBrowserAnnotationsAsMarkdown([
        makeAnnotation({
          payload: {
            ...annotation.payload,
            target: {
              ...annotation.payload.target,
              selector: `button[data-label="${manyBacktickRuns}"]`,
              htmlSnippet: `<button>${manyBacktickRuns}</button>`
            }
          }
        })
      ])
    ).not.toThrow()
    expect(matchAll).not.toHaveBeenCalled()
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

  it('bounds large inline page text without regex replacement passes', () => {
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const annotation = makeAnnotation()
    const repeatedInlineText = 'x '.repeat(BROWSER_ANNOTATION_INLINE_TEXT_MAX_LENGTH * 2)
    const repeatedFeedback = 'y\n'.repeat(BROWSER_ANNOTATION_INLINE_TEXT_MAX_LENGTH * 2)
    const largeInlineText = `Summary ${repeatedInlineText}SECRET_TAIL`
    const largeFeedback = `Feedback ${repeatedFeedback}SECRET_COMMENT`

    const markdown = formatBrowserAnnotationsAsMarkdown([
      makeAnnotation({
        comment: largeFeedback,
        payload: {
          ...annotation.payload,
          target: {
            ...annotation.payload.target,
            selectedText: largeInlineText,
            accessibility: {
              ...annotation.payload.target.accessibility,
              accessibleName: largeInlineText
            }
          },
          nearbyText: [largeInlineText]
        }
      })
    ])

    expect(markdown).toContain('**Selected text:** "Summary x x')
    expect(markdown).not.toContain('SECRET_TAIL')
    expect(markdown).not.toContain('SECRET_COMMENT')
    expect(replaceSpy).not.toHaveBeenCalled()
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
    expect(selectedLine).toBeDefined()
    expect(selectedLine).not.toContain('😀')
    expect(selectedLine).not.toContain('tail')
    expect(selectedLine).not.toContain('\ufffd')
  })
})
