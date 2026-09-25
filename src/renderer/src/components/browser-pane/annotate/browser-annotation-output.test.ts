import { afterEach, describe, expect, it, vi } from 'vitest'
import { syncGuestAnnotationViewportBridge } from './guest-annotation-viewport-bridge'
import type { BrowserPageAnnotation } from '../../../../../shared/browser-grab-types'
import {
  BROWSER_ANNOTATION_INLINE_TEXT_MAX_LENGTH,
  formatBrowserAnnotationsAsMarkdown
} from './browser-annotation-output'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
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

describe('annotations across navigation', () => {
  it('keeps page and tab context for every item in a multi-page batch', () => {
    const first = makeAnnotation()
    const second = makeAnnotation({ id: 'annotation-2', comment: 'Second page feedback' })
    second.payload.page.sanitizedUrl = 'https://example.com/contact'
    second.payload.page.viewportWidth = 800
    const markdown = formatBrowserAnnotationsAsMarkdown([first, second])
    expect(markdown).toContain('2 items across multiple pages')
    expect(markdown).toContain('**Page:** https://example.com/pricing')
    expect(markdown).toContain('**Page:** https://example.com/contact')
    expect(markdown).toContain('**Viewport:** 800x720')
    expect(markdown.match(/\*\*Browser tab id:\*\* page-1/g)).toHaveLength(2)
    expect(markdown).toContain('Second page feedback')
  })

  it('filters badges by current URL without changing their tray numbers', () => {
    const first = makeAnnotation()
    const second = makeAnnotation({ id: 'annotation-2' })
    second.payload.page.sanitizedUrl = 'https://example.com/contact'
    const setAnnotationViewportBridge = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { browser: { setAnnotationViewportBridge } } })
    const sync = (currentUrl: string) =>
      syncGuestAnnotationViewportBridge({
        toolTargetId: 'page-1',
        annotations: [first, second],
        currentUrl,
        pendingPayload: null,
        surfaceActive: true,
        token: 'token'
      })
    sync('https://example.com/contact')
    expect(setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        markers: [expect.objectContaining({ id: 'annotation-2', index: 1 })]
      })
    )
    sync('https://example.com/other')
    expect(setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: false,
        markers: []
      })
    )
    sync('https://example.com/pricing')
    expect(setAnnotationViewportBridge).toHaveBeenLastCalledWith(
      expect.objectContaining({
        enabled: true,
        markers: [expect.objectContaining({ id: 'annotation-1', index: 0 })]
      })
    )
  })

  it('keeps document preview badges when the surface has no navigation URL', () => {
    const setAnnotationViewportBridge = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('window', { api: { browser: { setAnnotationViewportBridge } } })
    syncGuestAnnotationViewportBridge({
      toolTargetId: 'preview-1',
      annotations: [makeAnnotation()],
      pendingPayload: null,
      surfaceActive: true,
      token: 'token'
    })
    expect(setAnnotationViewportBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
        markers: [expect.objectContaining({ id: 'annotation-1', index: 0 })]
      })
    )
  })
})
