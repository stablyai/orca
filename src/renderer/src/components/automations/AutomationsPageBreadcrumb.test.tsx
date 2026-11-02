// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { AutomationsPageBreadcrumb } from './AutomationsPageBreadcrumb'

describe('AutomationsPageBreadcrumb', () => {
  it('renders the selected automation as the detail-page breadcrumb', () => {
    const container = document.createElement('div')
    const root = createRoot(container)

    act(() => {
      root.render(
        <AutomationsPageBreadcrumb
          current="automation"
          automationName="Nightly sync"
          onBackToAutomations={vi.fn()}
        />
      )
    })

    expect(container.textContent).toContain('Automations')
    expect(container.textContent).toContain('Nightly sync')
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Nightly sync')

    act(() => root.unmount())
  })

  it('links a run detail page back through Runs and Automations', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const onBackToAutomations = vi.fn()
    const onBackToRuns = vi.fn()

    act(() => {
      root.render(
        <AutomationsPageBreadcrumb
          current="run"
          onBackToAutomations={onBackToAutomations}
          onBackToRuns={onBackToRuns}
        />
      )
    })

    expect(container.textContent).toContain('Automations')
    expect(container.textContent).toContain('Runs')
    expect(container.querySelector('[aria-current="page"]')?.textContent).toBe('Run details')

    const buttons = container.querySelectorAll('button')
    act(() => buttons[0]?.click())
    act(() => buttons[1]?.click())
    expect(onBackToAutomations).toHaveBeenCalledOnce()
    expect(onBackToRuns).toHaveBeenCalledOnce()

    act(() => root.unmount())
  })

  it('links an automation-origin run back to its automation details', () => {
    const container = document.createElement('div')
    const root = createRoot(container)
    const onBackToAutomation = vi.fn()

    act(() => {
      root.render(
        <AutomationsPageBreadcrumb
          current="run"
          automationName="Nightly sync"
          onBackToAutomations={vi.fn()}
          onBackToAutomation={onBackToAutomation}
        />
      )
    })

    expect(container.textContent).toContain('Nightly sync')
    expect(container.textContent).toContain('Run details')

    const buttons = container.querySelectorAll('button')
    act(() => buttons[1]?.click())
    expect(onBackToAutomation).toHaveBeenCalledOnce()

    act(() => root.unmount())
  })
})
