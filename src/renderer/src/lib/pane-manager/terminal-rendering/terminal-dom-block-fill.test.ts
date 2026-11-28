// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { applyDomBlockFills } from './terminal-dom-block-fill'

function renderRow(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = `<div class="xterm-rows"><div>${html}</div></div>`
  return root
}

describe('applyDomBlockFills', () => {
  it('fills the block cursor cell in currentColor so the blink still animates it', () => {
    const root = renderRow(
      '<span class="xterm-cursor xterm-cursor-blink xterm-cursor-block" style="color: rgb(255, 0, 0)">█</span>'
    )
    applyDomBlockFills(root)
    applyDomBlockFills(root)
    const span = root.querySelector('span')!
    expect(span.style.color).toBe('rgb(255, 0, 0)')
    expect(span.style.getPropertyValue('--orca-block-fg').toLowerCase()).toBe('currentcolor')
    expect(span.style.backgroundImage).toContain('linear-gradient')
  })
})
