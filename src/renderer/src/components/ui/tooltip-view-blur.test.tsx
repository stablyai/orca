// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip'

let root: Root | null = null
let container: HTMLDivElement

function renderTabTooltip(): void {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root!.render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span data-testid="tab-label">* Claude Code</span>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            * Claude Code
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  })
}

function hoverTrigger(): void {
  act(() => {
    document
      .querySelector<HTMLElement>('[data-testid="tab-label"]')!
      .dispatchEvent(new PointerEvent('pointermove', { bubbles: true }))
  })
}

async function settle(ms = 20): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  await act(async () => {
    await promise
  })
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount())
  }
  root = null
  document.body.replaceChildren()
})

describe('tab tooltip across window focus moves', () => {
  it('closes an open tooltip when its window loses focus', async () => {
    renderTabTooltip()
    hoverTrigger()
    await settle()
    expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull()

    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await settle()

    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
  })

  it('cancels a pending hover open when its window loses focus first', async () => {
    renderTabTooltip()
    hoverTrigger()
    act(() => {
      window.dispatchEvent(new Event('blur'))
    })
    await settle(50)

    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
  })

  it('keeps normal hover open and pointer-leave close working', async () => {
    renderTabTooltip()
    hoverTrigger()
    await settle()
    expect(document.querySelector('[data-slot="tooltip-content"]')).not.toBeNull()

    act(() => {
      document
        .querySelector<HTMLElement>('[data-testid="tab-label"]')!
        .dispatchEvent(new PointerEvent('pointerout', { bubbles: true }))
    })
    await settle()

    expect(document.querySelector('[data-slot="tooltip-content"]')).toBeNull()
  })

  it('invokes a cleanup returned from a React 19 consumer ref', () => {
    const consumerCleanup = vi.fn()
    const consumerRef = (_node: HTMLButtonElement | null): (() => void) => consumerCleanup
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    act(() => {
      root!.render(
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger ref={consumerRef} asChild>
              <span data-testid="tab-label">* Claude Code</span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              * Claude Code
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )
    })

    act(() => {
      root!.unmount()
    })
    root = null

    // Why: dropping the return value leaks whatever the consumer set up —
    // React 19 ref cleanups must run on unmount like the blur listener does.
    expect(consumerCleanup).toHaveBeenCalled()
  })
})
