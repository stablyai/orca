import { describe, expect, it } from 'vitest'
import type { BrowserRecorderElementSummary, BrowserRecorderStep } from './browser-recorder-types'
import {
  formatBrowserRecorderStepSummary,
  formatBrowserRecorderStepsAsMarkdown
} from './browser-recorder-output'

const element: BrowserRecorderElementSummary = {
  tagName: 'button',
  selector: 'form > button[type="submit"]',
  elementPath: 'body > form > button',
  cssClasses: 'btn primary',
  accessibleName: 'Submit order',
  textSnippet: 'Submit order now',
  rectViewport: { x: 12, y: 34, width: 120, height: 32 }
}

function makeStep(
  overrides: Partial<BrowserRecorderStep> & Pick<BrowserRecorderStep, 'detail'>
): BrowserRecorderStep {
  return {
    id: 'step-1',
    browserPageId: 'page-1',
    createdAt: '2026-07-31T10:15:30.000Z',
    pageUrl: 'https://example.com/checkout',
    pageTitle: 'Checkout',
    ...overrides
  }
}

describe('formatBrowserRecorderStepsAsMarkdown', () => {
  it('returns an empty string for an empty session', () => {
    expect(formatBrowserRecorderStepsAsMarkdown([])).toBe('')
  })

  it('renders the session header with start time, step count, and last page', () => {
    const steps = [
      makeStep({ detail: { kind: 'recording-started' } }),
      makeStep({
        id: 'step-2',
        detail: { kind: 'element-selected', element }
      })
    ]
    const output = formatBrowserRecorderStepsAsMarkdown(steps, {
      startedAt: '2026-07-31T10:15:30.000Z'
    })
    expect(output).toContain('## Browser Action Log')
    expect(output).toContain('**Started:**')
    expect(output).toContain('**Steps:** 2')
    expect(output).toContain('**Last page:** example.com/checkout')
  })

  it('renders a navigation step with from/to URLs and the page it happened on', () => {
    const step = makeStep({
      detail: {
        kind: 'navigation',
        fromUrl: 'https://example.com/cart',
        toUrl: 'https://example.com/checkout'
      }
    })
    const output = formatBrowserRecorderStepsAsMarkdown([step])
    expect(output).toContain('### 1. Navigated to a new page')
    expect(output).toContain('**Page:** https://example.com/checkout')
    expect(output).toContain('**From:** https://example.com/cart')
    expect(output).toContain('**To:** https://example.com/checkout')
  })

  it('renders an element selection with label, selector, bounds, and text', () => {
    const step = makeStep({ detail: { kind: 'element-selected', element } })
    const output = formatBrowserRecorderStepsAsMarkdown([step])
    expect(output).toContain('### 1. Selected element')
    expect(output).toContain('**Element:** button "Submit order"')
    expect(output).toContain('**Selector:** `form > button[type="submit"]`')
    expect(output).toContain('**Location:** `body > form > button`')
    expect(output).toContain('**Bounds:** x=12, y=34, 120x32')
    expect(output).toContain('**Classes:** `btn primary`')
    expect(output).toContain('**Text:** "Submit order now"')
  })

  it('renders an annotation with intent and comment', () => {
    const step = makeStep({
      detail: {
        kind: 'annotation-added',
        element,
        comment: 'Make the button green',
        intent: 'change'
      }
    })
    const output = formatBrowserRecorderStepsAsMarkdown([step])
    expect(output).toContain('### 1. Added annotation')
    expect(output).toContain('**Intent:** change')
    expect(output).toContain('**Feedback:** Make the button green')
  })

  it('renders an automation action with target, params, result, and DOM diff', () => {
    const step = makeStep({
      detail: {
        kind: 'automation-action',
        action: {
          id: 'act-1',
          method: 'browser.click',
          target: { kind: 'selector', value: '#login-btn' },
          params: { element: '#login-btn' },
          page: {
            browserPageId: 'page-1',
            url: 'https://example.com/login',
            title: 'Login'
          },
          startedAt: '2026-07-31T10:15:30.000Z',
          durationMs: 42,
          ok: true,
          error: null,
          urlAfter: 'https://example.com/dashboard',
          titleAfter: 'Dashboard',
          domDiff: {
            urlChanged: true,
            titleChanged: true,
            textLengthDelta: 280,
            interactiveDelta: 2,
            inputsChanged: true,
            changed: ['url', 'title', 'text', 'inputs', 'interactive']
          }
        }
      }
    })
    const output = formatBrowserRecorderStepsAsMarkdown([step])
    expect(output).toContain('### 1. Browser automation action')
    expect(output).toContain('**Method:** `browser.click`')
    expect(output).toContain('**Target:** selector `#login-btn`')
    expect(output).toContain('**Params:** element=#login-btn')
    expect(output).toContain('**Result:** ok (42ms)')
    expect(output).toContain('**URL:** https://example.com/login → https://example.com/dashboard')
    expect(output).toContain('**Title:** Login → Dashboard')
    expect(output).toContain('**DOM changed:** url, title, text +280, interactive +2, inputs')
  })

  it('renders a failed automation action with its error', () => {
    const step = makeStep({
      detail: {
        kind: 'automation-action',
        action: {
          id: 'act-2',
          method: 'browser.click',
          target: { kind: 'ref', value: '@e9' },
          params: { element: '@e9' },
          page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
          startedAt: '2026-07-31T10:15:31.000Z',
          durationMs: 9,
          ok: false,
          error: 'element not found: @e9',
          urlAfter: null,
          titleAfter: null,
          domDiff: null
        }
      }
    })
    const output = formatBrowserRecorderStepsAsMarkdown([step])
    expect(output).toContain('**Result:** error (9ms) — element not found: @e9')
  })

  it('escapes backtick runs in selectors so markdown stays valid', () => {
    const elementWithBackticks: BrowserRecorderElementSummary = {
      ...element,
      selector: 'code `x` and ``y``'
    }
    const step = makeStep({ detail: { kind: 'element-selected', element: elementWithBackticks } })
    const output = formatBrowserRecorderStepsAsMarkdown([step])
    expect(output).toContain('**Selector:** ``` code `x` and ``y`` ```')
  })
})

describe('formatBrowserRecorderStepSummary', () => {
  it('produces one-line summaries for every step kind', () => {
    expect(
      formatBrowserRecorderStepSummary(makeStep({ detail: { kind: 'recording-started' } }))
    ).toBe('Recording started')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: {
            kind: 'navigation',
            fromUrl: 'https://example.com/a',
            toUrl: 'https://example.com/b'
          }
        })
      )
    ).toBe('Navigated example.com/a → example.com/b')
    expect(
      formatBrowserRecorderStepSummary(makeStep({ detail: { kind: 'element-selected', element } }))
    ).toBe('Selected button "Submit order"')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: { kind: 'annotation-added', element, comment: 'x', intent: 'fix' }
        })
      )
    ).toBe('Annotated button "Submit order"')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: {
            kind: 'automation-action',
            action: {
              id: 'act-3',
              method: 'browser.type',
              target: { kind: 'selector', value: '#email' },
              params: { input: 'user@example.com' },
              page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
              startedAt: '2026-07-31T10:15:32.000Z',
              durationMs: 12,
              ok: true,
              error: null,
              urlAfter: null,
              titleAfter: null,
              domDiff: {
                urlChanged: false,
                titleChanged: false,
                textLengthDelta: 0,
                interactiveDelta: 0,
                inputsChanged: true,
                changed: ['inputs']
              }
            }
          }
        })
      )
    ).toBe('type #email ✓ (12ms) · inputs')
  })
})
