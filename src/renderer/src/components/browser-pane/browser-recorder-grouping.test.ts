import { describe, expect, it } from 'vitest'
import type { BrowserRecorderStep } from './browser-recorder-types'
import { groupRecorderSteps } from './browser-recorder-grouping'

function makeStep(id: string, detail: BrowserRecorderStep['detail']): BrowserRecorderStep {
  return {
    id,
    browserPageId: 'page-1',
    createdAt: '2026-07-31T10:15:30.000Z',
    pageUrl: 'https://example.com/a',
    pageTitle: 'A',
    detail
  }
}

const click = makeStep('click-1', {
  kind: 'interaction',
  interaction: {
    id: 'i-1',
    kind: 'click',
    page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
    startedAt: '2026-07-31T10:15:30.000Z',
    target: '#kaydet'
  }
})

const request = (id: string): BrowserRecorderStep =>
  makeStep(id, {
    kind: 'network-request',
    request: {
      id,
      page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
      startedAt: '2026-07-31T10:15:31.000Z',
      method: 'POST',
      url: 'https://example.com/api/stok',
      postData: null,
      status: 200,
      durationMs: 10,
      origin: null,
      triggeredBy: 'i-1',
      kind: 'xhr',
      screenChanged: []
    }
  })

const consoleEntry = makeStep('console-1', {
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
})

const hover = makeStep('hover-1', {
  kind: 'interaction',
  interaction: {
    id: 'i-2',
    kind: 'hover',
    page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
    startedAt: '2026-07-31T10:15:33.000Z',
    target: '#menu'
  }
})

describe('groupRecorderSteps', () => {
  it('attaches requests and console messages to their triggering lead', () => {
    const groups = groupRecorderSteps([click, request('r-1'), consoleEntry])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.lead?.id).toBe('click-1')
    expect(groups[0]?.items.map((item) => item.step.id)).toEqual(['r-1', 'console-1'])
    expect(groups[0]?.items.every((item) => item.kind === 'member')).toBe(true)
  })

  it('keeps the group open across hover/scroll but marks them inline', () => {
    // Why: a click's requests usually arrive after the mouse moved away
    // (loading blockers, tooltips) — hover must not sever the chain.
    const groups = groupRecorderSteps([click, request('r-1'), hover, request('r-2')])
    expect(groups).toHaveLength(1)
    expect(groups[0]?.lead?.id).toBe('click-1')
    expect(groups[0]?.items.map((item) => item.step.id)).toEqual(['r-1', 'hover-1', 'r-2'])
    expect(groups[0]?.items.map((item) => item.kind)).toEqual(['member', 'inline', 'member'])
  })

  it('closes the group at a selection/annotation/network-summary separator', () => {
    const selection = makeStep('sel-1', {
      kind: 'element-selected',
      element: {
        tagName: 'button',
        selector: '#x',
        textSnippet: 'X',
        rectViewport: { x: 0, y: 0, width: 1, height: 1 }
      }
    })
    const groups = groupRecorderSteps([click, request('r-1'), selection, request('r-2')])
    expect(groups).toHaveLength(3)
    expect(groups[0]?.lead?.id).toBe('click-1')
    expect(groups[0]?.items.map((item) => item.step.id)).toEqual(['r-1'])
    expect(groups[1]?.lead).toBeNull()
    expect(groups[1]?.items.map((item) => item.step.id)).toEqual(['sel-1'])
    expect(groups[2]?.lead).toBeNull()
    expect(groups[2]?.items.map((item) => item.step.id)).toEqual(['r-2'])
  })

  it('closes the group at an annotation-removed or markup separator', () => {
    const removed = makeStep('removed-1', { kind: 'annotation-removed', comment: 'x' })
    const markup = makeStep('markup-1', {
      kind: 'markup',
      shapes: [{ kind: 'text', at: { x: 0, y: 0 }, text: 'a' }]
    })
    const groups = groupRecorderSteps([click, request('r-1'), removed, markup, request('r-2')])
    expect(groups).toHaveLength(4)
    expect(groups[0]?.lead?.id).toBe('click-1')
    expect(groups[0]?.items.map((item) => item.step.id)).toEqual(['r-1'])
    expect(groups[1]?.lead).toBeNull()
    expect(groups[1]?.items.map((item) => item.step.id)).toEqual(['removed-1'])
    expect(groups[2]?.lead).toBeNull()
    expect(groups[2]?.items.map((item) => item.step.id)).toEqual(['markup-1'])
    expect(groups[3]?.lead).toBeNull()
    expect(groups[3]?.items.map((item) => item.step.id)).toEqual(['r-2'])
  })

  it('treats a request before any lead as standalone', () => {
    const groups = groupRecorderSteps([request('r-0'), click])
    expect(groups).toHaveLength(2)
    expect(groups[0]?.lead).toBeNull()
    expect(groups[0]?.items.map((item) => item.step.id)).toEqual(['r-0'])
    expect(groups[1]?.lead?.id).toBe('click-1')
  })

  it('opens a new group at every lead step', () => {
    const typeStep = makeStep('type-1', {
      kind: 'interaction',
      interaction: {
        id: 'i-3',
        kind: 'type',
        page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
        startedAt: '2026-07-31T10:15:34.000Z',
        text: 'ABC',
        target: '#kod'
      }
    })
    const actionStep = makeStep('action-1', {
      kind: 'automation-action',
      action: {
        id: 'a-1',
        method: 'browser.click',
        target: { kind: 'selector', value: '#x' },
        params: {},
        page: { browserPageId: 'page-1', url: 'https://example.com/a', title: 'A' },
        startedAt: '2026-07-31T10:15:35.000Z',
        durationMs: 5,
        ok: true,
        error: null,
        urlAfter: null,
        titleAfter: null,
        domDiff: null
      }
    })
    const groups = groupRecorderSteps([click, typeStep, actionStep])
    expect(groups.map((group) => group.lead?.id)).toEqual(['click-1', 'type-1', 'action-1'])
    expect(groups.every((group) => group.items.length === 0)).toBe(true)
  })

  it('returns an empty list for no steps', () => {
    expect(groupRecorderSteps([])).toEqual([])
  })
})
