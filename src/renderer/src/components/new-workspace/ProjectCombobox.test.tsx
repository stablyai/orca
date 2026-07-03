// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'
import ProjectCombobox from './ProjectCombobox'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandInput: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => <input ref={ref} {...props} />
  ),
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    onSelect,
    value
  }: {
    children: React.ReactNode
    onSelect?: (value: string) => void
    value: string
  }) => (
    <button type="button" data-command-value={value} onClick={() => onSelect?.(value)}>
      {children}
    </button>
  )
}))

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

    const trigger = container.querySelector('[data-project-combobox-root="true"][role="combobox"]')
    expect(trigger?.textContent).toContain('orca')
    expect(trigger?.textContent).not.toContain('SSH')
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
    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-command-value="github:stablyai/noqa"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
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

    const trigger = container.querySelector('[data-project-combobox-root="true"][role="combobox"]')
    expect(trigger?.textContent).toContain('Platform')
    expect(container.textContent).toContain('/tmp/platform')

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-command-value="project-group:folder-group"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onValueChange).toHaveBeenCalledWith('project-group:folder-group')
  })
})
