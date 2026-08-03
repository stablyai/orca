// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import ProjectCombobox from './ProjectCombobox'

// Render the popover inline so assertions can reach the list without a portal.
// `onOpenChange` is exposed on a button so a test can close the popover the way
// Radix does on Escape — independently of the component's own key handler.
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
    field().dispatchEvent(new FocusEvent('focus', { bubbles: true }))
  })
}

function rowFor(optionId: string): HTMLElement {
  const row = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find((node) =>
    node.textContent?.includes(optionId)
  )
  if (!row) {
    throw new Error(`row not found for ${optionId}`)
  }
  return row
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
  it('renders a logical project label without host-specific SSH chrome', () => {
    act(() => {
      root.render(
        <ProjectCombobox options={projects} value="github:stablyai/orca" onValueChange={vi.fn()} />
      )
    })

    const shell = container.querySelector('[data-project-combobox-root="true"]')
    expect(shell?.textContent).toContain('orca')
    expect(shell?.textContent).not.toContain('SSH')
  })

  it('keeps a focusable combobox that composer focus helpers can target', () => {
    act(() => {
      root.render(<ProjectCombobox options={projects} value={null} onValueChange={vi.fn()} />)
    })

    const trigger = container.querySelector<HTMLElement>(
      '[data-project-combobox-root="true"][role="combobox"]'
    )
    expect(trigger).toBeTruthy()
    act(() => {
      trigger?.focus()
    })
    expect(document.activeElement).toBe(trigger)
  })

  it('selects projects by logical project id', () => {
    const onValueChange = vi.fn()

    act(() => {
      root.render(
        <ProjectCombobox
          options={projects}
          value="github:stablyai/orca"
          onValueChange={onValueChange}
        />
      )
    })
    openList()
    act(() => {
      rowFor('stablyai/noqa').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onValueChange).toHaveBeenCalledWith('github:stablyai/noqa')
  })

  it('renders and selects project-group options', () => {
    const onValueChange = vi.fn()

    act(() => {
      root.render(
        <ProjectCombobox
          options={projects}
          value="project-group:folder-group"
          onValueChange={onValueChange}
        />
      )
    })

    const shell = container.querySelector('[data-project-combobox-root="true"]')
    expect(shell?.textContent).toContain('Platform')
    openList()
    expect(container.textContent).toContain('/tmp/platform')

    act(() => {
      rowFor('/tmp/platform').dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onValueChange).toHaveBeenCalledWith('project-group:folder-group')
  })

  it('always offers an "Add a new project" action, including when the list is empty', () => {
    const onAddProject = vi.fn()

    act(() => {
      root.render(
        <ProjectCombobox
          options={[]}
          value={null}
          onValueChange={vi.fn()}
          onAddProject={onAddProject}
        />
      )
    })
    openList()

    const addRow = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (node) => node.textContent?.includes('Add a new project')
    )
    expect(addRow).toBeTruthy()

    act(() => {
      addRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onAddProject).toHaveBeenCalledTimes(1)
  })

  it('keeps "Add a new project" reachable when the search matches nothing', () => {
    const onAddProject = vi.fn()

    act(() => {
      root.render(
        <ProjectCombobox
          options={projects}
          value={null}
          onValueChange={vi.fn()}
          onAddProject={onAddProject}
        />
      )
    })
    openList()
    type('zzzznomatch')

    expect(container.textContent).toContain('No projects match your search.')
    const addRow = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]')).find(
      (node) => node.textContent?.includes('Add a new project')
    )
    expect(addRow).toBeTruthy()

    act(() => {
      addRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onAddProject).toHaveBeenCalledTimes(1)
  })

  it('omits the "Add a new project" action when no handler is provided', () => {
    act(() => {
      root.render(<ProjectCombobox options={projects} value={null} onValueChange={vi.fn()} />)
    })
    openList()

    expect(container.textContent).not.toContain('Add a new project')
  })

  it('renders directory details for duplicate project names', () => {
    const duplicateProjects: NewWorkspaceProjectOption[] = [
      {
        kind: 'project',
        id: 'project:merchant-a',
        projectId: 'project:merchant-a',
        displayName: 'merchant',
        badgeColor: '#111111',
        detail: '/workspace/storefront/merchant'
      },
      {
        kind: 'project',
        id: 'project:merchant-b',
        projectId: 'project:merchant-b',
        displayName: 'merchant',
        badgeColor: '#222222',
        detail: '/workspace/admin/merchant'
      }
    ]

    act(() => {
      root.render(
        <ProjectCombobox options={duplicateProjects} value={null} onValueChange={vi.fn()} />
      )
    })
    openList()

    expect(container.textContent).toContain('/workspace/storefront/merchant')
    expect(container.textContent).toContain('/workspace/admin/merchant')
  })

  it('filters as the user types, without a second search box', () => {
    act(() => {
      root.render(<ProjectCombobox options={projects} value={null} onValueChange={vi.fn()} />)
    })
    openList()
    // The field itself is the only text input in the control.
    expect(container.querySelectorAll('input')).toHaveLength(1)

    type('noq')
    expect(container.textContent).toContain('stablyai/noqa')
    expect(container.textContent).not.toContain('stablyai/orca')
  })

  it('commits the armed row on Enter', () => {
    const onValueChange = vi.fn()
    const onValueSelected = vi.fn()

    act(() => {
      root.render(
        <ProjectCombobox
          options={projects}
          value={null}
          onValueChange={onValueChange}
          onValueSelected={onValueSelected}
        />
      )
    })
    openList()
    type('noq')
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })

    expect(onValueChange).toHaveBeenCalledWith('github:stablyai/noqa')
    expect(onValueSelected).toHaveBeenCalledWith('github:stablyai/noqa')
  })

  it('arms "Add a new project" when a query matches nothing, so Enter is never a wrong guess', () => {
    const onAddProject = vi.fn()
    const onValueChange = vi.fn()

    act(() => {
      root.render(
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

  it('restores the committed project on Escape instead of stranding a stale query', () => {
    act(() => {
      root.render(
        <ProjectCombobox options={projects} value="github:stablyai/orca" onValueChange={vi.fn()} />
      )
    })
    openList()
    type('zzzznomatch')
    expect(field().value).toBe('zzzznomatch')
    // Radix closes the popover itself on Escape/outside-click, leaving a closed
    // list with a live query — the state that used to strand the field showing
    // text matching nothing while hiding the committed project.
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-test-close-popover]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    expect(field().value).toBe('')
    const shell = container.querySelector('[data-project-combobox-root="true"]')
    expect(shell?.textContent).toContain('orca')
  })

  it('drops an uncommitted query when the list closes, so junk text never persists', () => {
    act(() => {
      root.render(
        <ProjectCombobox options={projects} value="github:stablyai/orca" onValueChange={vi.fn()} />
      )
    })
    openList()
    type('asasdasd')
    expect(field().value).toBe('asasdasd')

    // Blur / outside-click closes via Radix, not the key handler.
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-test-close-popover]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(field().value).toBe('')
    const shell = container.querySelector('[data-project-combobox-root="true"]')
    expect(shell?.textContent).toContain('orca')
  })

  it('marks the field invalid so a failed create press can turn it red', () => {
    act(() => {
      root.render(
        <ProjectCombobox
          options={projects}
          value={null}
          onValueChange={vi.fn()}
          invalid
          describedBy="project-error"
        />
      )
    })

    expect(field().getAttribute('aria-invalid')).toBe('true')
    expect(field().getAttribute('aria-describedby')).toBe('project-error')
  })

  // Empty query + >=6 matches + a folder group triggers sectioning, which sinks
  // folders below Projects. Arming raw rank order armed the BOTTOM row, so Enter
  // on open created the workspace in the folder group.
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

  it('arms the first rendered row when sections reorder the list', () => {
    act(() => {
      root.render(
        <ProjectCombobox options={sectionedOptions} value={null} onValueChange={vi.fn()} />
      )
    })
    openList()

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    expect(rows.length).toBeGreaterThan(1)
    expect(rows[0]?.getAttribute('data-armed')).toBe('true')
    expect(rows.filter((row) => row.getAttribute('data-armed') === 'true')).toHaveLength(1)
  })

  it('commits the top row on Enter rather than the folder group sectioned to the bottom', () => {
    const onValueChange = vi.fn()

    act(() => {
      root.render(
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

  it('steps ArrowDown to the next rendered row instead of jumping across sections', () => {
    act(() => {
      root.render(
        <ProjectCombobox options={sectionedOptions} value={null} onValueChange={vi.fn()} />
      )
    })
    openList()
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })

    const rows = Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'))
    expect(rows[1]?.getAttribute('data-armed')).toBe('true')
  })

  it('owns every option from the listbox, with no unroled wrapper in between', () => {
    act(() => {
      root.render(
        <ProjectCombobox
          options={projects}
          value={null}
          onValueChange={vi.fn()}
          onAddProject={vi.fn()}
        />
      )
    })
    openList()

    const listbox = container.querySelector('[role="listbox"]')
    expect(listbox).toBeTruthy()
    const options = Array.from(listbox?.querySelectorAll('[role="option"]') ?? [])
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) {
      let parent = option.parentElement
      while (parent && parent !== listbox) {
        // A bare wrapper here breaks the listbox → option relationship for AT.
        expect(parent.getAttribute('role')).toBeTruthy()
        parent = parent.parentElement
      }
    }
  })
})
