import { describe, expect, it } from 'vitest'
import { formatBrowserRecorderStepSummary } from './browser-recorder-output'
import { element, makeStep } from './browser-recorder-step-fixtures'

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
    ).toBe('Selected button "Submit order" ([type="submit"])')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: { kind: 'annotation-added', element, comment: 'x', intent: 'fix' }
        })
      )
    ).toBe('Annotated button "Submit order" ([type="submit"]) [fix]')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({ detail: { kind: 'annotation-removed', comment: 'x' } })
      )
    ).toBe('Removed annotation')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: {
            kind: 'markup',
            shapes: [{ kind: 'arrow', from: { x: 0, y: 0 }, to: { x: 10, y: 10 } }]
          }
        })
      )
    ).toBe('Markup copied (1 shape)')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: { kind: 'markup', shapes: [{ kind: 'text', at: { x: 1, y: 2 }, text: 'x' }] }
        })
      )
    ).toBe('Markup copied (1 shape)')
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
                inputChanges: [
                  { key: '#email', label: '#email', before: '', after: 'user@example.com' }
                ],
                textChange: null,
                changed: ['inputs']
              }
            }
          }
        })
      )
    ).toBe('type #email ✓ (12ms) · inputs')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: {
            kind: 'interaction',
            interaction: {
              id: 'i-1',
              kind: 'type',
              page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
              startedAt: '2026-07-31T10:15:30.000Z',
              text: 'ABC',
              target: '#stok_kod'
            }
          }
        })
      )
    ).toBe('User type "ABC" into `#stok_kod`')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: {
            kind: 'console',
            entry: {
              id: 'c-1',
              level: 'warning',
              message: 'Slow network detected',
              source: 'x.js',
              lineNumber: 1,
              repeatCount: 4,
              page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
              startedAt: '2026-07-31T10:15:30.000Z'
            }
          }
        })
      )
    ).toBe('Console warning ×4: Slow network detected')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: {
            kind: 'network-request',
            request: {
              id: 'n-1',
              page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
              startedAt: '2026-07-31T10:15:30.000Z',
              method: 'GET',
              url: 'https://example.com/data',
              postData: null,
              status: 200,
              durationMs: 30,
              origin: null,
              triggeredBy: null,
              kind: 'xhr',
              screenChanged: []
            }
          }
        })
      )
    ).toBe('Request GET https://example.com/data → 200')
    expect(
      formatBrowserRecorderStepSummary(
        makeStep({
          detail: {
            kind: 'network-summary',
            summary: {
              id: 'n-1',
              page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
              startedAt: '2026-07-31T10:15:30.000Z',
              total: 5,
              failed: 2,
              totalBytes: 0,
              byStatus: []
            }
          }
        })
      )
    ).toBe('Network: 5 requests, 2 failed')
  })
})
