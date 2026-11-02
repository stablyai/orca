// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyDomBlockFills, attachDomBlockFill } from './terminal-dom-block-fill'

describe('applyDomBlockFills', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  function mountSpan(text: string, color = 'rgb(30, 30, 30)'): HTMLSpanElement {
    const rows = document.createElement('div')
    rows.className = 'xterm-rows'
    const span = document.createElement('span')
    span.textContent = text
    span.style.color = color
    span.style.backgroundColor = 'rgb(10, 10, 10)'
    const row = document.createElement('div')
    row.appendChild(span)
    rows.appendChild(row)
    document.body.appendChild(rows)
    return span
  }

  it('paints a uniform ▀ composer border with a cell-filling gradient', () => {
    const span = mountSpan('▀'.repeat(12))

    applyDomBlockFills(document)

    expect(span.style.color).toBe('transparent')
    expect(span.style.backgroundImage).toContain('linear-gradient(to bottom')
    expect(span.style.backgroundSize).toBe(`${100 / 12}% 100%`)
    expect(span.style.backgroundRepeat).toBe('repeat-x')
    expect(span.style.getPropertyValue('--orca-block-fg')).toBe('rgb(30, 30, 30)')
  })

  it('does not restyle mixed block/letter spans', () => {
    const span = mountSpan('▀▀█ Ask')
    applyDomBlockFills(document)
    expect(span.style.color).toBe('rgb(30, 30, 30)')
    expect(span.style.backgroundImage).toBe('')
  })

  it('visits only the rows xterm repainted', () => {
    const first = mountSpan('▀▀▀')
    const rows = first.parentElement!.parentElement!
    const secondRow = document.createElement('div')
    const second = document.createElement('span')
    second.textContent = '▄▄▄'
    second.style.color = 'rgb(30, 30, 30)'
    secondRow.appendChild(second)
    rows.appendChild(secondRow)
    const untouched = vi.spyOn(first, 'textContent', 'get')

    applyDomBlockFills(document, { start: 1, end: 1 })

    expect(untouched).not.toHaveBeenCalled()
    expect(first.style.backgroundImage).toBe('')
    expect(second.style.backgroundImage).toContain('linear-gradient')
  })

  it('clears a previous fill when the span is reused for ordinary text', () => {
    const span = mountSpan('▀▀▀')
    applyDomBlockFills(document)
    span.textContent = 'tab agents'
    applyDomBlockFills(document)
    expect(span.style.backgroundImage).toBe('')
    expect(span.style.backgroundSize).toBe('')
    expect(span.style.backgroundRepeat).toBe('')
    expect(span.style.color).toBe('rgb(30, 30, 30)')
  })

  it('uses a color set on a reused filled span instead of the saved one', () => {
    const span = mountSpan('▀▀▀')
    applyDomBlockFills(document)
    span.style.color = 'rgb(200, 0, 0)'
    applyDomBlockFills(document)
    expect(span.style.color).toBe('transparent')
    expect(span.style.getPropertyValue('--orca-block-fg')).toBe('rgb(200, 0, 0)')

    span.textContent = 'tab agents'
    applyDomBlockFills(document)
    expect(span.style.color).toBe('rgb(200, 0, 0)')
  })

  it('keeps a color set after the fill when the span becomes ordinary text', () => {
    const span = mountSpan('▀▀▀')
    applyDomBlockFills(document)
    span.style.color = 'rgb(0, 200, 0)'
    span.textContent = 'tab agents'
    applyDomBlockFills(document)
    expect(span.style.color).toBe('rgb(0, 200, 0)')
    expect(span.style.backgroundImage).toBe('')
  })

  it('does not pin an inherited color inline when clearing a fill', () => {
    const span = mountSpan('▀▀▀', '')
    span.parentElement!.style.color = 'rgb(5, 5, 5)'
    applyDomBlockFills(document)
    expect(span.style.getPropertyValue('--orca-block-fg')).toBe('rgb(5, 5, 5)')

    span.textContent = 'tab agents'
    applyDomBlockFills(document)
    expect(span.style.color).toBe('')
  })
})

describe('attachDomBlockFill', () => {
  it('fills row replacements from focus/selection without rescanning untouched rows', async () => {
    const element = document.createElement('div')
    const rows = document.createElement('div')
    rows.className = 'xterm-rows'
    element.appendChild(rows)
    const untouched = document.createElement('div')
    const original = document.createElement('span')
    original.textContent = 'ordinary text'
    untouched.appendChild(original)
    rows.appendChild(untouched)
    const changed = document.createElement('div')
    rows.appendChild(changed)
    const detach = attachDomBlockFill({ element })
    const unread = vi.spyOn(original, 'textContent', 'get')
    const span = document.createElement('span')
    span.textContent = '▀▀'
    span.style.color = 'rgb(1, 2, 3)'
    changed.replaceChildren(span)

    await vi.waitFor(() => expect(span.style.color).toBe('transparent'))
    expect(unread).not.toHaveBeenCalled()
    detach()
    const replacement = document.createElement('span')
    replacement.textContent = '▄▄'
    replacement.style.color = 'rgb(1, 2, 3)'
    changed.replaceChildren(replacement)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(replacement.style.color).toBe('rgb(1, 2, 3)')
  })

  it('fills a new DOM renderer container after a GPU mode change', async () => {
    const element = document.createElement('div')
    const detach = attachDomBlockFill({ element })
    const rows = document.createElement('div')
    rows.className = 'xterm-rows'
    const row = document.createElement('div')
    const span = document.createElement('span')
    span.textContent = '▀▀'
    span.style.color = 'rgb(1, 2, 3)'
    row.appendChild(span)
    rows.appendChild(row)
    element.appendChild(rows)

    await vi.waitFor(() => expect(span.style.color).toBe('transparent'))
    detach()
  })
})
