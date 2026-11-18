// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SidebarSectionHeader } from './SidebarSectionHeader'

afterEach(cleanup)

function renderHeader(props: Partial<React.ComponentProps<typeof SidebarSectionHeader>> = {}) {
  return render(
    <TooltipProvider>
      <SidebarSectionHeader title="Projects" sectionId="projects" actions={null} {...props} />
    </TooltipProvider>
  )
}

describe('SidebarSectionHeader', () => {
  it('has no fold button unless the section can fold', () => {
    const view = renderHeader()
    expect(view.queryByRole('button')).toBeNull()
  })

  it('folds from the title area and reports its state', () => {
    const onToggle = vi.fn()
    const view = renderHeader({ fold: { collapsed: true, label: 'Expand Projects', onToggle } })
    const button = view.getByRole('button', { name: 'Expand Projects' })
    expect(button.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(button)
    expect(onToggle).toHaveBeenCalledTimes(1)
  })

  it('puts the fold chevron before the title', () => {
    const view = renderHeader({
      fold: { collapsed: false, label: 'Collapse Projects', onToggle: vi.fn() }
    })
    const chevron = view.container.querySelector('svg')
    const title = view.container.querySelector('[data-sidebar-section-title="projects"]')
    expect(chevron).not.toBeNull()
    expect(title).not.toBeNull()
    expect(chevron!.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('hides the chevron while there is nothing to fold', () => {
    const view = renderHeader({
      fold: { collapsed: false, disabled: true, label: 'Bots', onToggle: vi.fn() }
    })
    expect(view.container.querySelector('svg')).toBeNull()
  })

  it('keeps the title accessory a separate control from the fold', () => {
    const onToggle = vi.fn()
    const onCollapseAll = vi.fn()
    const view = renderHeader({
      fold: { collapsed: false, label: 'Collapse Projects', onToggle },
      titleAccessory: (
        <button type="button" onClick={onCollapseAll}>
          Collapse all projects
        </button>
      )
    })
    fireEvent.click(view.getByRole('button', { name: 'Collapse all projects' }))
    expect(onCollapseAll).toHaveBeenCalledTimes(1)
    expect(onToggle).not.toHaveBeenCalled()
  })
})
