// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Dialog, DialogContent, DialogTitle } from './dialog'

const APPEARANCE_PROPERTIES = ['--popover', '--popover-foreground', '--border'] as const

let host: HTMLDivElement
let root: Root
let style: HTMLStyleElement
let previousActEnvironment: boolean | undefined
let previousAppearance: string | null
let previousProperties: { property: string; value: string; priority: string }[]

describe('App Appearance portaled primitives', () => {
  beforeEach(() => {
    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    previousAppearance = document.documentElement.getAttribute('data-app-appearance')
    previousProperties = APPEARANCE_PROPERTIES.map((property) => ({
      property,
      value: document.documentElement.style.getPropertyValue(property),
      priority: document.documentElement.style.getPropertyPriority(property)
    }))
    style = document.createElement('style')
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
    host.remove()
    style.remove()
    const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    if (previousActEnvironment === undefined) {
      delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
    } else {
      actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
    }
    if (previousAppearance === null) {
      document.documentElement.removeAttribute('data-app-appearance')
    } else {
      document.documentElement.dataset.appAppearance = previousAppearance
    }
    for (const { property, value, priority } of previousProperties) {
      if (value) {
        document.documentElement.style.setProperty(property, value, priority)
      } else {
        document.documentElement.style.removeProperty(property)
      }
    }
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
