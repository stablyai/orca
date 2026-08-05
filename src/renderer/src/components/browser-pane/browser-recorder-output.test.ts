import { describe, expect, it } from 'vitest'
import type { BrowserRecorderStep } from './browser-recorder-types'
import {
  formatBrowserRecorderStepsAsMarkdown,
  formatCompactStepLine
} from './browser-recorder-output'
import { element, makeStep } from './browser-recorder-step-fixtures'

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
      '2. navigate `example.com/cart` → `example.com/checkout` @ example.com/checkout',
      '3. selected button "Submit order" @ example.com/checkout',
      '4. annotated button "Submit order": "Make the button green" @ example.com/checkout'
    ])
  })

  it('annotates steps with the gap since the previous step (+Ns / +Ms)', () => {
    const base = '2026-07-31T10:15:30.000Z'
    const output = formatBrowserRecorderStepsAsMarkdown([
      makeStep({ detail: { kind: 'recording-started' }, createdAt: base }),
      makeStep({
        id: 'step-2',
        createdAt: '2026-07-31T10:15:35.000Z',
        detail: { kind: 'element-selected', element }
      }),
      makeStep({
        id: 'step-3',
        createdAt: '2026-07-31T10:16:45.000Z',
        detail: { kind: 'element-selected', element }
      }),
      makeStep({
        id: 'step-4',
        createdAt: '2026-07-31T10:16:45.500Z',
        detail: { kind: 'element-selected', element }
      })
    ])
    const lines = output.split('\n').filter((line) => /^\d+\./.test(line))
    expect(lines[0]).toContain('1. recording started')
    expect(lines[1]).toBe('2. (+5s) selected button "Submit order" @ example.com/checkout')
    expect(lines[2]).toBe('3. (+1m10s) selected button "Submit order" @ example.com/checkout')
    // Sub-second gap renders without a label.
    expect(lines[3]).toBe('4. selected button "Submit order" @ example.com/checkout')
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
            inputChanges: [
              { key: '#email', label: '#email', before: '', after: 'user@example.com' }
            ],
            textChange: null,
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

  it('renders the DOM text change snippet when text shifted', () => {
    const step = makeStep({
      detail: {
        kind: 'automation-action',
        action: {
          id: 'act-3',
          method: 'browser.click',
          target: { kind: 'selector', value: '#kaydet' },
          params: { element: '#kaydet' },
          page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
          startedAt: '2026-07-31T10:15:32.000Z',
          durationMs: 21,
          ok: true,
          error: null,
          urlAfter: null,
          titleAfter: null,
          domDiff: {
            urlChanged: false,
            titleChanged: false,
            textLengthDelta: 14,
            interactiveDelta: 0,
            inputsChanged: false,
            inputChanges: [],
            textChange: { before: 'Stok kaydedildi', after: 'Stok guncellendi' },
            changed: ['text']
          }
        }
      }
    })
    expect(formatCompactStepLine(step)).toBe(
      'action click #kaydet ok (21ms) · changed: text +14 · text: "Stok kaydedildi" → "Stok guncellendi" @ example.com/checkout'
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
        'click `#login-btn` (340,215) @ example.com/checkout'
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
        'type "user@example.com" into `#email` @ example.com/checkout'
      ],
      [
        {
          kind: 'interaction',
          interaction: {
            id: 'i-3',
            kind: 'keydown',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:30.000Z',
            key: 'Enter',
            target: '#email'
          }
        },
        'key Enter `#email` @ example.com/checkout'
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
        'hover `#menu-stok` @ example.com/checkout'
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
      ],
      [
        {
          kind: 'interaction',
          interaction: {
            id: 'i-6',
            kind: 'change',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:30.000Z',
            value: '2',
            target: '#suz_kosul1'
          }
        },
        'change `#suz_kosul1` = 2 @ example.com/checkout'
      ],
      [
        {
          kind: 'interaction',
          interaction: {
            id: 'i-7',
            kind: 'clipboard',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:30.000Z',
            clipboardAction: 'paste',
            clipboardText: '153.049 - TEST',
            target: '#urun_kod'
          }
        },
        'clipboard paste "153.049 - TEST" `#urun_kod` @ example.com/checkout'
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
          screenChanged: ['text', 'inputs'],
          response: '{"ok":true,"kayitNo":42}',
          responseSize: 26,
          responseTruncated: false
        }
      }
    })
    expect(formatCompactStepLine(step)).toBe(
      'request POST `https://example.com/api/stok` → 200 (85ms) · fn: stokKaydet@stok.php:142 · changed: text,inputs · islem=stok_kaydet,ad=Test · resp: {"ok":true,"kayitNo":42} @ example.com/checkout'
    )
  })

  it('marks a truncated response with its full size', () => {
    const step = makeStep({
      detail: {
        kind: 'network-request',
        request: {
          id: 'n-3',
          page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
          startedAt: '2026-07-31T10:15:30.000Z',
          method: 'GET',
          url: 'https://example.com/api/big',
          postData: null,
          status: 200,
          durationMs: 12,
          origin: null,
          triggeredBy: null,
          kind: 'fetch',
          screenChanged: [],
          response: '{"rows":[{"id":1},',
          responseSize: 18432,
          responseTruncated: true
        }
      }
    })
    expect(formatCompactStepLine(step)).toContain('resp: {"rows":[{"id":1}, …(18432b)')
  })

  it('renders a head+tail truncated response with its omitted marker', () => {
    const step = makeStep({
      detail: {
        kind: 'network-request',
        request: {
          id: 'n-4',
          page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
          startedAt: '2026-07-31T10:15:30.000Z',
          method: 'GET',
          url: 'https://example.com/api/liste',
          postData: null,
          status: 200,
          durationMs: 12,
          origin: null,
          triggeredBy: null,
          kind: 'fetch',
          screenChanged: [],
          // In-page head+tail truncation keeps the marker between the slices.
          response: '<table><thead>…[500 chars omitted]…<tr><td>last row</td></tr></table>',
          responseSize: 5832,
          responseTruncated: true
        }
      }
    })
    const line = formatCompactStepLine(step)
    expect(line).toContain('<table><thead>')
    expect(line).toContain('[500 chars omitted]')
    expect(line).toContain('<tr><td>last row</td></tr>')
    expect(line).toContain('…(5832b)')
  })

  it('marks a schematized HTML response with its label', () => {
    const step = makeStep({
      detail: {
        kind: 'network-request',
        request: {
          id: 'n-5',
          page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
          startedAt: '2026-07-31T10:15:30.000Z',
          method: 'GET',
          url: 'https://example.com/api/liste',
          postData: null,
          status: 200,
          durationMs: 12,
          origin: null,
          triggeredBy: null,
          kind: 'fetch',
          screenChanged: [],
          // Schematized: tags stripped, visible text + controls remain.
          response: 'Fatura No 6675\n[controls] button "Düzenle" · input#belgeno "6675"',
          responseSize: 148232,
          responseTruncated: false,
          responseSchema: 'html'
        }
      }
    })
    const line = formatCompactStepLine(step)
    expect(line).toContain('resp: [html→text] Fatura No 6675')
    expect(line).toContain('button "Düzenle"')
    expect(line).toContain('input#belgeno "6675"')
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
    expect(lines[0]).toBe('1. click `button.btn-save` (620,480) @ example.com/checkout')
    expect(lines[1]).toContain('2.   └ request POST')
    // Why: console messages after a trigger belong to the same group as its
    // requests — they are indented with them.
    expect(lines[2]).toBe('3.   └ console log "ok" (a.js) @ example.com/checkout')
  })

  it('keeps requests grouped under their trigger across a hover', () => {
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
            postData: null,
            status: 200,
            durationMs: 85,
            origin: null,
            triggeredBy: 'i-1',
            kind: 'xhr',
            screenChanged: []
          }
        }
      }),
      makeStep({
        id: 'step-3',
        detail: {
          kind: 'interaction',
          interaction: {
            id: 'i-2',
            kind: 'hover',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:32.000Z',
            target: '#loading_blocker'
          }
        }
      }),
      makeStep({
        id: 'step-4',
        detail: {
          kind: 'network-request',
          request: {
            id: 'r-2',
            page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
            startedAt: '2026-07-31T10:15:33.000Z',
            method: 'GET',
            url: 'https://example.com/api/urun_liste',
            postData: null,
            status: 200,
            durationMs: 10,
            origin: null,
            triggeredBy: 'i-1',
            kind: 'xhr',
            screenChanged: []
          }
        }
      })
    ]
    const lines = formatBrowserRecorderStepsAsMarkdown(steps)
      .split('\n')
      .filter((line) => /^\d+\./.test(line))
    expect(lines[0]).toBe('1. click `button.btn-save` (620,480) @ example.com/checkout')
    expect(lines[1]).toContain('2.   └ request POST')
    // Why: hover renders on its own line but keeps the group open, so the
    // request triggered by the click still hangs under it.
    expect(lines[2]).toBe('3. hover `#loading_blocker` @ example.com/checkout')
    expect(lines[3]).toContain('4.   └ request GET')
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
