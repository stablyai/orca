// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { ProjectHeaderHostTooltip } from './ProjectHeaderHostLabel'

beforeAll(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
})
afterAll(() => {
  vi.unstubAllGlobals()
})

const cleanup: (() => void)[] = []
afterEach(() => {
  for (const release of cleanup.splice(0)) {
    release()
  }
})

async function renderHeader(delayDuration = 0) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  cleanup.push(() => {
    act(() => root.unmount())
    container.remove()
  })
  await act(async () => {
    root.render(
      <TooltipProvider delayDuration={delayDuration}>
        <ProjectHeaderHostTooltip
          label="app"
          context={{ hostId: 'runtime:home', label: 'Home', detail: 'Orca server' }}
        >
          <div role="button" tabIndex={0}>
            <span>app</span>
            <span data-repo-header-action="" data-collapse-chevron="">
              Collapse
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" data-repo-header-action="">
                  Menu
                </button>
              </TooltipTrigger>
              <TooltipContent>Project actions</TooltipContent>
            </Tooltip>
          </div>
        </ProjectHeaderHostTooltip>
      </TooltipProvider>
    )
  })
  return container
}

describe('project header host tooltip focus', () => {
  it('opens the full identity tooltip when the header itself receives keyboard focus', async () => {
    const container = await renderHeader()
    const header = container.querySelector<HTMLElement>('[role="button"]')
    await act(async () => {
      header?.focus()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'app — Home'
    )
  })

  it('leaves a nested action tooltip open when the action receives keyboard focus', async () => {
    const container = await renderHeader()
    const action = container.querySelector('button')
    await act(async () => {
      action?.focus()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const texts = [...document.querySelectorAll('[data-slot="tooltip-content"]')].map(
      (element) => element.textContent
    )
    expect(texts).toContain('Project actions')
    expect(texts.some((text) => text?.includes('app — Home'))).toBe(false)
  })
  it('leaves a nested action tooltip open when hovering its button', async () => {
    const container = await renderHeader()
    const action = container.querySelector('button')
    await act(async () => {
      action?.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
      )
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const texts = [...document.querySelectorAll('[data-slot="tooltip-content"]')].map(
      (element) => element.textContent
    )
    expect(texts).toContain('Project actions')
    expect(texts.some((text) => text?.includes('app — Home'))).toBe(false)
  })

  it('shows the header tooltip when hovering project text inside the header', async () => {
    const container = await renderHeader()
    const text = container.querySelector('span')
    await act(async () => {
      text?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(document.querySelector('[data-slot="tooltip-content"]')?.textContent).toContain(
      'app — Home'
    )
  })
  it.each(['button', '[data-collapse-chevron]'])(
    'cancels the pending identity tooltip when the pointer moves from project text to %s',
    async (selector) => {
      const container = await renderHeader(40)
      const text = container.querySelector('span')
      const action = container.querySelector(selector)
      await act(async () => {
        text?.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
        )
        await new Promise((resolve) => setTimeout(resolve, 10))
        action?.dispatchEvent(
          new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
        )
        await new Promise((resolve) => setTimeout(resolve, 80))
      })
      const texts = [...document.querySelectorAll('[data-slot="tooltip-content"]')].map(
        (element) => element.textContent
      )
      expect(texts.some((text) => text?.includes('app — Home'))).toBe(false)
      if (selector === 'button') {
        expect(texts).toContain('Project actions')
      }
    }
  )

  it('restores the identity tooltip when the pointer returns from an action to project text', async () => {
    const container = await renderHeader(40)
    const text = container.querySelector('span')
    const action = container.querySelector('button')
    await act(async () => {
      action?.dispatchEvent(
        new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' })
      )
      await new Promise((resolve) => setTimeout(resolve, 80))
      text?.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }))
      await new Promise((resolve) => setTimeout(resolve, 80))
    })
    expect(
      [...document.querySelectorAll('[data-slot="tooltip-content"]')].some((element) =>
        element.textContent?.includes('app — Home')
      )
    ).toBe(true)
  })
})
