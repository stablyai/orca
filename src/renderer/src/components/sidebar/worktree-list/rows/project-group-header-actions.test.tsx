// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { ProjectGroupAddProjectButton } from './project-group-header-actions'

const group: ProjectGroup = {
  id: 'group-1',
  name: 'OSS',
  parentPath: null,
  connectionId: null,
  executionHostId: null,
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

let root: Root | null = null
let container: HTMLDivElement

function renderButton(
  onAddProject: (projectGroup: ProjectGroup) => void,
  rowHandlers: {
    onClick?: () => void
    onPointerDown?: () => void
    onKeyDown?: () => void
  } = {}
): HTMLButtonElement {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <TooltipProvider>
        {/* Why: the real header row arms drag/collapse on these events; the button must swallow them. */}
        <div
          onClick={rowHandlers.onClick}
          onPointerDown={rowHandlers.onPointerDown}
          onKeyDown={rowHandlers.onKeyDown}
        >
          <ProjectGroupAddProjectButton
            projectGroup={group}
            label="OSS"
            onAddProject={onAddProject}
          />
        </div>
      </TooltipProvider>
    )
  })
  const button = container.querySelector('button')
  if (!button) {
    throw new Error('button did not render')
  }
  return button
}

describe('ProjectGroupAddProjectButton', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
  })

  it('renders as a hover header action named after the group', () => {
    const button = renderButton(vi.fn())

    expect(button.getAttribute('aria-label')).toBe('Add project to OSS')
    expect(button.hasAttribute('data-repo-header-action')).toBe(true)
  })

  it('hands the clicked group to the add-project callback', () => {
    const onAddProject = vi.fn()
    const button = renderButton(onAddProject)

    act(() => {
      button.click()
    })

    expect(onAddProject).toHaveBeenCalledTimes(1)
    expect(onAddProject).toHaveBeenCalledWith(group)
  })

  it('does not let the click toggle the header row', () => {
    const onClick = vi.fn()
    const button = renderButton(vi.fn(), { onClick })

    act(() => {
      button.click()
    })

    expect(onClick).not.toHaveBeenCalled()
  })

  it('does not arm the header drag on pointer down', () => {
    const onPointerDown = vi.fn()
    const button = renderButton(vi.fn(), { onPointerDown })

    act(() => {
      button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    })

    expect(onPointerDown).not.toHaveBeenCalled()
  })

  it('keeps Enter on the button from collapsing the header', () => {
    const onKeyDown = vi.fn()
    const button = renderButton(vi.fn(), { onKeyDown })

    act(() => {
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onKeyDown).not.toHaveBeenCalled()
  })
})
