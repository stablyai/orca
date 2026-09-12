// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PaletteOpenTabPrimaryLine } from './worktree-jump-palette-primitives'

const URL = 'help.pulley.com/en/articles/4856643-how-do-i-convert-a-safe-or-convertible-note'
const TITLE = 'How do I convert a SAFE or convertible note?'

let container: HTMLDivElement
let root: Root

function renderLine(secondaryRanges: readonly { start: number; end: number }[] = []): void {
  act(() => {
    root.render(
      <PaletteOpenTabPrimaryLine
        title={TITLE}
        titleRanges={[]}
        secondaryText={URL}
        secondaryRanges={secondaryRanges}
        worktreeName="virtual-assistant"
        worktreeRanges={[]}
      />
    )
  })
}

function secondaryElement(): HTMLElement {
  const element = container.querySelector<HTMLElement>('[data-slot="palette-open-tab-secondary"]')
  if (!element) {
    throw new Error('secondary line missing')
  }
  return element
}

describe('PaletteOpenTabPrimaryLine', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders the tab title in full and elides the url', () => {
    renderLine()
    const title = container.querySelector('[data-slot="palette-open-tab-title"]')
    expect(title?.textContent).toBe(TITLE)
    const secondary = secondaryElement()
    expect(secondary.textContent).toBe('help.pulley.com/en/articl…')
    expect(secondary.getAttribute('title')).toBe(URL)
    expect(secondary.className).toContain('max-w-[min(26%,13rem)]')
  })

  it('keeps a matched url segment visible in the elided text', () => {
    const start = URL.indexOf('safe')
    renderLine([{ start, end: start + 4 }])
    const secondary = secondaryElement()
    expect(secondary.textContent).toContain('safe')
    expect(secondary.querySelector('span')?.textContent).toBe('safe')
  })

  it('leaves a short url unelided and untitled', () => {
    act(() => {
      root.render(
        <PaletteOpenTabPrimaryLine
          title={TITLE}
          titleRanges={[]}
          secondaryText="help.pulley.com"
          secondaryRanges={[]}
          worktreeName=""
          worktreeRanges={[]}
        />
      )
    })
    const secondary = secondaryElement()
    expect(secondary.textContent).toBe('help.pulley.com')
    expect(secondary.hasAttribute('title')).toBe(false)
  })
})
