// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from './dialog'

let host: HTMLDivElement
let root: Root

describe('App Appearance portaled primitives', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const style = document.createElement('style')
    style.textContent = `
      .bg-popover { background-color: var(--popover); }
      .text-popover-foreground { color: var(--popover-foreground); }
      .border-border { border-color: var(--border); }
    `
    document.head.append(style)
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    document.documentElement.dataset.appAppearance = 'match-terminal'
    document.documentElement.style.setProperty('--popover', 'rgb(18 52 86)')
    document.documentElement.style.setProperty('--popover-foreground', 'rgb(250 251 252)')
    document.documentElement.style.setProperty('--border', 'rgb(90 91 92)')
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    document.body.replaceChildren()
    document.head.querySelector('style')?.remove()
    document.documentElement.removeAttribute('data-app-appearance')
    document.documentElement.removeAttribute('style')
  })

  it('renders dialog content in the body portal with inherited semantic colors', async () => {
    await act(async () => {
      root.render(
        <Dialog open>
          <DialogContent>
            <DialogTitle>Appearance preview</DialogTitle>
          </DialogContent>
        </Dialog>
      )
    })

    const content = document.body.querySelector<HTMLElement>('[data-slot="dialog-content"]')
    expect(content).not.toBeNull()
    expect(host.contains(content)).toBe(false)
    expect(content?.className).toContain('bg-popover')
    expect(content?.className).toContain('text-popover-foreground')
    expect(getComputedStyle(content!).backgroundColor).toBe('rgb(18 52 86)')
    expect(getComputedStyle(content!).color).toBe('rgb(250 251 252)')
    expect(getComputedStyle(content!).borderColor).toBe('rgb(90 91 92)')
  })
})
