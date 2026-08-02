// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProjectGroupDeleteDialog } from './ProjectGroupDeleteDialog'

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  document.body.innerHTML = ''
})

function renderDialog(
  overrides: Partial<React.ComponentProps<typeof ProjectGroupDeleteDialog>> = {}
): void {
  act(() => {
    root.render(
      <ProjectGroupDeleteDialog
        open={true}
        groupName="Platform"
        projectCount={2}
        projectNames={['API', 'Web app']}
        removeContainedProjects={false}
        onRemoveContainedProjectsChange={vi.fn()}
        onOpenChange={vi.fn()}
        onConfirm={vi.fn()}
        {...overrides}
      />
    )
  })
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button')).find((entry) =>
    entry.textContent?.includes(label)
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

function getCheckbox(): HTMLButtonElement {
  const checkbox = document.body.querySelector('[role="checkbox"]')
  if (!(checkbox instanceof HTMLButtonElement)) {
    throw new Error('Checkbox not rendered')
  }
  return checkbox
}

describe('ProjectGroupDeleteDialog', () => {
  it('omits the contained project panel for empty groups', () => {
    renderDialog({ projectCount: 0 })

    expect(document.body.querySelector('[role="checkbox"]')).toBeNull()
    expect(document.body.textContent).not.toContain('contained project')
  })

  it('renders compact contained project handling and reports remove intent', () => {
    const onRemoveContainedProjectsChange = vi.fn()
    renderDialog({ onRemoveContainedProjectsChange })

    expect(document.body.textContent).toContain('Delete Platform.')
    expect(document.body.textContent).toContain('Contained projects')
    expect(document.body.textContent).not.toContain('unless selected below')
    expect(getCheckbox().getAttribute('aria-checked')).toBe('false')
    expect(document.body.textContent).toContain('Remove 2 contained projects')
    expect(document.body.textContent).not.toContain('Remove 2 contained projects from Orca')
    expect(document.body.textContent).toContain('Project folders on disk are not deleted.')
    expect(document.body.textContent).toContain('API')
    expect(document.body.textContent).toContain('Web app')

    act(() => {
      getCheckbox().click()
    })

    expect(onRemoveContainedProjectsChange).toHaveBeenCalledWith(true)
  })

  it('focuses the delete group action when opened', () => {
    renderDialog()

    expect(document.activeElement).toBe(findButton('Delete Group'))
  })

  it('keeps the panel copy and destructive action label stable when project removal is selected', () => {
    renderDialog({ removeContainedProjects: true })

    expect(document.body.textContent).toContain('Delete Platform.')
    expect(document.body.textContent).not.toContain('will stay in Orca')
    expect(document.body.textContent).not.toContain('will be removed from Orca')
    expect(document.body.textContent).not.toContain('unless selected below')
    expect(getCheckbox().getAttribute('aria-checked')).toBe('true')
    expect(findButton('Delete Group')).toBeTruthy()
    expect(document.body.textContent).not.toContain('Delete Group and Remove Projects')
  })

  it('disables project choices, cancel, and delete actions while deleting', async () => {
    let finishConfirm: () => void = () => undefined
    const onConfirm = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishConfirm = resolve
        })
    )
    renderDialog({ onConfirm })

    act(() => {
      findButton('Delete Group').click()
    })

    expect(getCheckbox().disabled).toBe(true)
    expect(findButton('Cancel').disabled).toBe(true)
    expect(findButton('Deleting...').disabled).toBe(true)

    await act(async () => {
      finishConfirm()
      await Promise.resolve()
    })
  })
})
