import { describe, expect, it } from 'vitest'
import type { BrowserRecorderElementSummary, BrowserRecorderStep } from './browser-recorder-types'
import {
  formatBrowserRecorderStepsAsMarkdown,
  formatCompactStepLine
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

  it('renders every step as a single compact line ending with its page', () => {
    const output = formatBrowserRecorderStepsAsMarkdown([
      makeStep({ detail: { kind: 'recording-started' } }),
      makeStep({
        detail: {
          kind: 'navigation',
          fromUrl: 'https://example.com/cart',
          toUrl: 'https://example.com/checkout'
        }
      }),
      makeStep({ detail: { kind: 'element-selected', element } }),
      makeStep({
        detail: {
          kind: 'annotation-added',
          element,
          comment: 'Make the button green',
          intent: 'change'
        }
      })
    ])
    const lines = output.split('\n').filter((line) => /^\d+\. /.test(line))
    expect(lines).toEqual([
      '1. recording started @ example.com/checkout',
      '2. navigate example.com/cart → example.com/checkout @ example.com/checkout',
      '3. selected button "Submit order" @ example.com/checkout',
      '4. annotated button "Submit order": "Make the button green" @ example.com/checkout'
    ])
  })

  it('renders an automation action with result, diff, and per-field changes on one line', () => {
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
            inputChanges: [{ label: '#email', before: '', after: 'user@example.com' }],
            changed: ['url', 'title', 'text', 'inputs', 'interactive']
          }
        }
      }
    })
    expect(formatCompactStepLine(step)).toBe(
      'action click #login-btn ok (42ms) · changed: url,title,text +280,interactive +2,inputs · #email ""→"user@example.com" @ example.com/checkout'
    )
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
    expect(formatCompactStepLine(step)).toBe(
      'action click @e9 error: element not found: @e9 (9ms) @ example.com/checkout'
    )
  })

  it('renders manual interactions compactly (click, type, key, hover, scroll)', () => {
    const cases: [BrowserRecorderStep['detail'], string][] = [
      [
        {
          kind: 'interaction',
          interaction: {
            id: 'i-1',
            kind: 'click',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:30.000Z',
            x: 340,
            y: 215,
            target: '#login-btn',
            tagName: 'button'
          }
        },
        'click #login-btn (340,215) @ example.com/checkout'
      ],
      [
        {
          kind: 'interaction',
          interaction: {
            id: 'i-2',
            kind: 'type',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:30.000Z',
            text: 'user@example.com',
            target: '#email'
          }
        },
        'type "user@example.com" into #email @ example.com/checkout'
      ],
      [
        {
          kind: 'interaction',
          interaction: {
            id: 'i-3',
            kind: 'keydown',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:30.000Z',
            key: 'Enter'
          }
        },
        'key Enter @ example.com/checkout'
      ],
      [
        {
          kind: 'interaction',
          interaction: {
            id: 'i-4',
            kind: 'hover',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:30.000Z',
            target: '#menu-stok'
          }
        },
        'hover #menu-stok @ example.com/checkout'
      ],
      [
        {
          kind: 'interaction',
          interaction: {
            id: 'i-5',
            kind: 'scroll',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:30.000Z',
            scrollX: 0,
            scrollY: 1200
          }
        },
        'scroll x=0, y=1200 @ example.com/checkout'
      ]
    ]
    for (const [detail, expected] of cases) {
      expect(formatCompactStepLine(makeStep({ detail }))).toBe(expected)
    }
  })

  it('renders a coalesced console entry with repeat count and source', () => {
    const step = makeStep({
      detail: {
        kind: 'console',
        entry: {
          id: 'c-1',
          level: 'error',
          message: 'Uncaught TypeError: x is not a function',
          source: 'a.js',
          lineNumber: 12,
          repeatCount: 23,
          page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
          startedAt: '2026-07-31T10:15:30.000Z'
        }
      }
    })
    expect(formatCompactStepLine(step)).toBe(
      'console error ×23 "Uncaught TypeError: x is not a function" (a.js) @ example.com/checkout'
    )
  })

  it('renders a network request with status, screen change, and body', () => {
    const step = makeStep({
      detail: {
        kind: 'network-request',
        request: {
          id: 'n-1',
          page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
          startedAt: '2026-07-31T10:15:30.000Z',
          method: 'POST',
          url: 'https://example.com/api/stok',
          postData: 'islem=stok_kaydet,ad=Test',
          status: 200,
          durationMs: 85,
          origin: 'stokKaydet@stok.php:142',
          triggeredBy: 'page-1:interaction:5',
          kind: 'xhr',
          screenChanged: ['text', 'inputs']
        }
      }
    })
    expect(formatCompactStepLine(step)).toBe(
      'request POST `https://example.com/api/stok` → 200 (85ms) · fn: stokKaydet@stok.php:142 · changed: text,inputs · islem=stok_kaydet,ad=Test @ example.com/checkout'
    )
  })

  it('renders an iframe navigation as a frame request', () => {
    const step = makeStep({
      detail: {
        kind: 'network-request',
        request: {
          id: 'n-2',
          page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
          startedAt: '2026-07-31T10:15:30.000Z',
          method: 'GET',
          url: 'https://example.com/panel/stok',
          postData: null,
          status: 200,
          durationMs: null,
          origin: null,
          triggeredBy: 'page-1:interaction:5',
          kind: 'frame',
          screenChanged: []
        }
      }
    })
    expect(formatCompactStepLine(step)).toBe(
      'frame GET `https://example.com/panel/stok` → 200 @ example.com/checkout'
    )
  })

  it('indents network requests under their triggering interaction', () => {
    const steps: BrowserRecorderStep[] = [
      makeStep({
        detail: {
          kind: 'interaction',
          interaction: {
            id: 'i-1',
            kind: 'click',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:30.000Z',
            x: 620,
            y: 480,
            target: 'button.btn-save'
          }
        }
      }),
      makeStep({
        id: 'step-2',
        detail: {
          kind: 'network-request',
          request: {
            id: 'r-1',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:31.000Z',
            method: 'POST',
            url: 'https://example.com/api/stok',
            postData: 'islem=stok_kaydet',
            status: 200,
            durationMs: 85,
            origin: 'stokKaydet@stok.php:142',
            triggeredBy: 'i-1',
            kind: 'xhr',
            screenChanged: ['inputs']
          }
        }
      }),
      makeStep({
        id: 'step-3',
        detail: {
          kind: 'console',
          entry: {
            id: 'c-1',
            level: 'log',
            message: 'ok',
            source: 'a.js',
            lineNumber: 1,
            repeatCount: 1,
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:32.000Z'
          }
        }
      })
    ]
    const lines = formatBrowserRecorderStepsAsMarkdown(steps)
      .split('\n')
      .filter((line) => /^\d+\./.test(line))
    expect(lines[0]).toBe('1. click button.btn-save (620,480) @ example.com/checkout')
    expect(lines[1]).toContain('2.   └ request POST')
    expect(lines[2]).toBe('3. console log "ok" (a.js) @ example.com/checkout')
  })

  it('renders a network summary with status buckets', () => {
    const step = makeStep({
      detail: {
        kind: 'network-summary',
        summary: {
          id: 'n-2',
          page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
          startedAt: '2026-07-31T10:15:30.000Z',
          total: 3,
          failed: 1,
          totalBytes: 1536,
          byStatus: [
            { status: 200, count: 2 },
            { status: 404, count: 1 }
          ]
        }
      }
    })
    expect(formatCompactStepLine(step)).toBe(
      'network: 3 requests, 1 failed (200×2, 404×1) @ example.com/checkout'
    )
  })
})
