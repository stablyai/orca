// @vitest-environment happy-dom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

const FILL = 'rgba(255, 255, 255, 0.6)'

// Mirrors the inline fills the pane manager (root), xterm, and the pane title overlay paint.
function mountTerminal(
  host: HTMLElement
): Record<'root' | 'xterm' | 'scrollable' | 'title', HTMLElement> {
  host.innerHTML = `
    <div data-role="root" style="background: ${FILL}">
      <div class="pane">
        <div class="xterm-container">
          <div data-role="xterm" class="terminal xterm allow-transparency" style="background-color: ${FILL}">
            <div data-role="scrollable" class="xterm-scrollable-element" style="background-color: ${FILL}"></div>
          </div>
        </div>
      </div>
    </div>
    <div class="pane-title-overlay-layer" style="--orca-pane-title-bg: ${FILL}">
      <div data-role="title" class="pane-title-bar"></div>
    </div>`
  const get = (role: string): HTMLElement => {
    const el = host.querySelector<HTMLElement>(`[data-role="${role}"]`)
    if (!el) {
      throw new Error(`missing ${role}`)
    }
    return el
  }
  return {
    root: get('root'),
    xterm: get('xterm'),
    scrollable: get('scrollable'),
    title: get('title')
  }
}

const background = (el: HTMLElement): string => getComputedStyle(el).backgroundColor

describe('terminal surface under an app background image', () => {
  beforeAll(() => {
    const style = document.createElement('style')
    style.textContent = readFileSync(resolve('src/renderer/src/assets/main.css'), 'utf8')
    document.head.appendChild(style)
    const terminalStyle = document.createElement('style')
    terminalStyle.textContent = readFileSync(
      resolve('src/renderer/src/assets/terminal.css'),
      'utf8'
    )
    document.head.appendChild(terminalStyle)
  })

  it('drops the pane title fill so it does not stack on the pane root', () => {
    const host = document.createElement('div')
    host.setAttribute('data-app-background', 'window')
    document.body.appendChild(host)
    const { root, title } = mountTerminal(host)

    expect(background(root)).toBe(FILL)
    expect(background(title)).toBe('transparent')
    host.remove()
  })

  it('leaves every terminal fill untouched without a background image', () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { root, xterm, scrollable, title } = mountTerminal(host)

    expect(background(root)).toBe(FILL)
    expect(background(xterm)).toBe(FILL)
    expect(background(scrollable)).toBe(FILL)
    expect(background(title)).toBe(FILL)
    host.remove()
  })
})
