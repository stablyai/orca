// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SidebarViewToggle } from './sidebar-view-toggle'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe('SidebarViewToggle', () => {
  it('exposes radio semantics with a roving tabindex so arrow keys move between tabs', () => {
    act(() => {
      root.render(
        <SidebarViewToggle
          ariaLabel="Sidebar view"
          value="agents"
          onSelect={() => undefined}
          options={[
            { value: 'workspaces', label: 'Spaces', sectionTitle: 'projects' },
            { value: 'agents', label: 'Agents', sectionTitle: 'agents' }
          ]}
        />
      )
    })

    const items = [...container.querySelectorAll('[role="radio"]')]
    expect(items).toHaveLength(2)
    const agents = container.querySelector('[data-sidebar-section-title="agents"]')
    const projects = container.querySelector('[data-sidebar-section-title="projects"]')
    expect(agents?.getAttribute('aria-checked')).toBe('true')
    expect(projects?.getAttribute('aria-checked')).toBe('false')
    // Only one tab is in the tab order (roving tabindex); arrow keys reach the other.
    const tabStops = items.map((item) => item.getAttribute('tabindex'))
    expect(tabStops.filter((stop) => stop === '0')).toHaveLength(1)
    expect(tabStops.filter((stop) => stop === '-1')).toHaveLength(1)
  })

  it('never deselects when the active tab is clicked again', () => {
    const onSelect = vi.fn()
    act(() => {
      root.render(
        <SidebarViewToggle
          ariaLabel="Sidebar view"
          value="agents"
          onSelect={onSelect}
          options={[
            { value: 'workspaces', label: 'Spaces', sectionTitle: 'projects' },
            { value: 'agents', label: 'Agents', sectionTitle: 'agents' }
          ]}
        />
      )
    })
    const agents = container.querySelector<HTMLButtonElement>(
      '[data-sidebar-section-title="agents"]'
    )
    act(() => agents?.click())
    expect(onSelect).not.toHaveBeenCalled()
    const projects = container.querySelector<HTMLButtonElement>(
      '[data-sidebar-section-title="projects"]'
    )
    act(() => projects?.click())
    expect(onSelect).toHaveBeenCalledWith('workspaces')
  })

  it('moves focus to the radio an arrow key selects', () => {
    // Without the focus move, every later arrow press steps from the old index and
    // keeps re-selecting the same neighbour.
    const onSelect = vi.fn()
    act(() => {
      root.render(
        <SidebarViewToggle
          ariaLabel="Sidebar view"
          value="workspaces"
          onSelect={onSelect}
          options={[
            { value: 'workspaces', label: 'Spaces', sectionTitle: 'projects' },
            { value: 'agents', label: 'Agents', sectionTitle: 'agents' }
          ]}
        />
      )
    })

    const projects = container.querySelector<HTMLButtonElement>(
      '[data-sidebar-section-title="projects"]'
    )
    act(() => {
      projects?.focus()
      projects?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true })
      )
    })

    expect(onSelect).toHaveBeenCalledWith('agents')
    expect(document.activeElement).toBe(
      container.querySelector('[data-sidebar-section-title="agents"]')
    )
  })

  it('keeps the visible label on one line', () => {
    act(() => {
      root.render(
        <SidebarViewToggle
          ariaLabel="Sidebar view"
          value="workspaces"
          onSelect={() => undefined}
          options={[
            {
              value: 'workspaces',
              label: 'Spaces',
              sectionTitle: 'projects'
            },
            { value: 'agents', label: 'Agents', sectionTitle: 'agents' }
          ]}
        />
      )
    })

    const group = container.querySelector('[role="radiogroup"]')
    const groupClasses = new Set(group?.className.split(/\s+/) ?? [])
    expect(groupClasses.has('inline-flex')).toBe(true)
    expect(groupClasses.has('shrink-0')).toBe(true)
    expect(groupClasses.has('flex-1')).toBe(false)

    const spacesTab = container.querySelector('[data-sidebar-section-title="projects"]')
    const visibleLabel = [...(spacesTab?.querySelectorAll('span') ?? [])].find(
      (span) => span.getAttribute('aria-hidden') == null && span.textContent === 'Spaces'
    )
    expect(visibleLabel?.className).toContain('whitespace-nowrap')
    expect(visibleLabel?.className.includes('truncate')).toBe(false)
  })
})
