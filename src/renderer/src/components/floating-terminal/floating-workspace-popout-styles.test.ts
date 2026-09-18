// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { syncPopoutStyles } from './floating-workspace-popout-styles'

function makeSource(): HTMLDivElement {
  const source = document.createElement('div')
  source.innerHTML = [
    '<link rel="stylesheet" href="/assets/app.css">',
    '<style>.xterm { font-family: monospace; }</style>'
  ].join('')
  return source
}

function makeHead(): HTMLHeadElement {
  return document.createElement('head')
}

function markedKeys(head: HTMLHeadElement): string[] {
  return Array.from(head.querySelectorAll('[data-floating-workspace-style-clone]')).map(
    (node) => node.getAttribute('data-floating-workspace-style-clone') ?? ''
  )
}

describe('syncPopoutStyles', () => {
  it('clones missing sheets once and reports no change on resync', () => {
    const source = makeSource()
    const head = makeHead()
    expect(syncPopoutStyles(source, head)).toBe(true)
    expect(head.querySelectorAll('link[rel="stylesheet"], style')).toHaveLength(2)
    expect(syncPopoutStyles(source, head)).toBe(false)
    expect(head.querySelectorAll('link[rel="stylesheet"], style')).toHaveLength(2)
  })

  it('matches links by raw href so about:blank resolution cannot duplicate', () => {
    const source = makeSource()
    const head = makeHead()
    expect(syncPopoutStyles(source, head)).toBe(true)
    const clone = head.querySelector('link[rel="stylesheet"]')
    expect(clone).not.toBeNull()
    // Why: the popout document resolves .href against about:blank — the sync must
    // never read it, so a diverged property still dedupes by attribute.
    Object.defineProperty(clone, 'href', { value: 'about:blank://diverged', configurable: true })
    expect(syncPopoutStyles(source, head)).toBe(false)
    expect(head.querySelectorAll('link[rel="stylesheet"]')).toHaveLength(1)
  })

  it('skips empty style tags that would otherwise pile up every sync', () => {
    const source = document.createElement('div')
    source.innerHTML = '<style>   </style><style>.real { color: red; }</style>'
    const head = makeHead()
    expect(syncPopoutStyles(source, head)).toBe(true)
    expect(head.querySelectorAll('style')).toHaveLength(1)
    expect(syncPopoutStyles(source, head)).toBe(false)
  })

  it('prunes clones whose source left and keeps popup-only nodes', () => {
    const source = makeSource()
    const head = makeHead()
    expect(syncPopoutStyles(source, head)).toBe(true)
    const popupOnly = document.createElement('style')
    popupOnly.textContent = '.popup-only { display: none; }'
    head.appendChild(popupOnly)
    source.querySelector('style')?.remove()
    expect(syncPopoutStyles(source, head)).toBe(true)
    expect(markedKeys(head)).toHaveLength(1)
    expect(head.contains(popupOnly)).toBe(true)
  })

  it('restores source order when a late sheet belongs in the middle', () => {
    const source = makeSource()
    const head = makeHead()
    expect(syncPopoutStyles(source, head)).toBe(true)
    const late = document.createElement('style')
    late.textContent = '.late { color: blue; }'
    source.insertBefore(late, source.querySelector('style'))
    syncPopoutStyles(source, head)
    const ordered = Array.from(head.querySelectorAll('link[rel="stylesheet"], style')).map(
      (node) => node.tagName
    )
    expect(ordered).toEqual(['LINK', 'STYLE', 'STYLE'])
    expect(head.querySelectorAll('style')[0]?.textContent).toContain('.late')
  })
})
