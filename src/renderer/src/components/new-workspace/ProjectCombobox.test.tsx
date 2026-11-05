// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import ProjectCombobox from './ProjectCombobox'
import { TooltipProvider } from '@/components/ui/tooltip'

// Render inline and expose Radix-style close independently of the component key handler.
vi.mock('@/components/ui/popover', () => ({
  Popover: ({
    children,
    onOpenChange
  }: {
    children: React.ReactNode
    onOpenChange?: (open: boolean) => void
  }) => (
    <div>
      <button type="button" data-test-close-popover onClick={() => onOpenChange?.(false)} />
      {children}
    </div>
  ),
  PopoverAnchor: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('./use-recent-project-ids', () => ({ useRecentProjectIds: () => [] }))

let container: HTMLDivElement
let root: Root

function renderField(element: React.ReactNode): void {
  root.render(<TooltipProvider>{element}</TooltipProvider>)
}

const projects: NewWorkspaceProjectOption[] = [
  {
    kind: 'project',
    id: 'github:stablyai/orca',
    projectId: 'github:stablyai/orca',
    displayName: 'orca',
    badgeColor: '#111111',
    detail: 'stablyai/orca'
  },
  {
    kind: 'project',
    id: 'github:stablyai/noqa',
    projectId: 'github:stablyai/noqa',
    displayName: 'noqa',
    badgeColor: '#222222',
    detail: 'stablyai/noqa'
  },
  {
    kind: 'project-group',
    id: 'project-group:folder-group',
    projectGroupId: 'folder-group',
    displayName: 'Platform',
    badgeColor: '#333333',
    detail: '/tmp/platform',
    parentPath: '/tmp/platform',
    connectionId: null
  }
]

function field(): HTMLInputElement {
  const node = container.querySelector<HTMLInputElement>(
    'input[data-project-combobox-root="true"][role="combobox"]'
  )
  if (!node) {
    throw new Error('project combobox field not found')
  }
  return node
}

function openList(): void {
  act(() => {
    field().focus()
  })
}

function type(value: string): void {
  const input = field()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
})

describe('ProjectCombobox', () => {
  it('arms "Add project" when a query matches nothing, so Enter is never a wrong guess', () => {
    const onAddProject = vi.fn()
    const onValueChange = vi.fn()

    act(() => {
      renderField(
        <ProjectCombobox
          options={projects}
          value={null}
          onValueChange={onValueChange}
          onAddProject={onAddProject}
        />
      )
    })
    openList()
    type('zzzznomatch')
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onAddProject).toHaveBeenCalledTimes(1)
    expect(onValueChange).not.toHaveBeenCalled()
  })

  // Sectioning sinks folders below projects; raw rank would arm the bottom row and Enter would choose the wrong project.
  const sectionedOptions: NewWorkspaceProjectOption[] = [
    ...Array.from({ length: 5 }, (_, index) => ({
      kind: 'project' as const,
      id: `project-${index}`,
      projectId: `project-${index}`,
      displayName: `svc-${index}`,
      badgeColor: '#111111',
      detail: `stablyai/svc-${index}`
    })),
    {
      kind: 'project-group',
      id: 'project-group:apps',
      projectGroupId: 'apps',
      displayName: 'Apps',
      badgeColor: '#333333',
      detail: '/tmp/apps',
      parentPath: '/tmp/apps',
      connectionId: null
    }
  ]

  it('commits the top row on Enter rather than the folder group sectioned to the bottom', () => {
    const onValueChange = vi.fn()

    act(() => {
      renderField(
        <ProjectCombobox options={sectionedOptions} value={null} onValueChange={onValueChange} />
      )
    })
    act(() => {
      container
        .querySelector<HTMLElement>('[data-project-combobox-root="true"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onValueChange).toHaveBeenCalledWith('project-0')
    expect(onValueChange).not.toHaveBeenCalledWith('project-group:apps')
  })
})
