// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NewWorkspaceProjectOption } from '@/lib/workspace/creation/new-workspace-project-options'
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
    field().click()
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
  // Regression: D4's cloud-only rows once used a `github:` key prefix, which swallowed every
  // GitHub project (ids are `github:<owner>/<repo>`) so picking one did nothing.
  it('commits a GitHub project, with or without cloud-only repositories listed', () => {
    for (const cloudRepos of [
      null,
      [{ fullName: 'acme/infra', url: 'https://github.com/acme/infra', private: true }]
    ]) {
      const onValueChange = vi.fn()
      const onCloudRepoSelected = vi.fn()
      act(() => {
        renderField(
          <ProjectCombobox
            options={projects}
            value={null}
            onValueChange={onValueChange}
            cloudRepos={cloudRepos}
            onCloudRepoSelected={onCloudRepoSelected}
          />
        )
      })
      openList()
      type('noqa')
      act(() => {
        field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      })
      expect(onValueChange).toHaveBeenCalledWith('github:stablyai/noqa')
      expect(onCloudRepoSelected).not.toHaveBeenCalled()
      type('')
    }
  })

  it('commits a listed cloud-only repository through its own callback', () => {
    const onValueChange = vi.fn()
    const onCloudRepoSelected = vi.fn()
    act(() => {
      renderField(
        <ProjectCombobox
          options={projects}
          value={null}
          onValueChange={onValueChange}
          cloudRepos={[
            { fullName: 'acme/infra', url: 'https://github.com/acme/infra', private: true }
          ]}
          onCloudRepoSelected={onCloudRepoSelected}
        />
      )
    })
    openList()
    type('infra')
    act(() => {
      field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    })
    expect(onCloudRepoSelected).toHaveBeenCalledWith('acme/infra')
    expect(onValueChange).not.toHaveBeenCalled()
  })

  // PROJ-MENU: a short "GitHub" header, one line per repository, and the cloud-only fact in each
  // row's accessible name (never only in the badge).
  it('lists cloud-only repositories under "GitHub", one line each, named for screen readers', () => {
    act(() => {
      renderField(
        <ProjectCombobox
          options={projects}
          value={null}
          onValueChange={vi.fn()}
          cloudRepos={[
            { fullName: 'acme/infra', url: 'https://github.com/acme/infra', private: true },
            { fullName: 'acme/site', url: 'https://github.com/acme/site', private: false }
          ]}
          onCloudRepoSelected={vi.fn()}
        />
      )
    })
    openList()
    type('acme')
    const group = document.querySelector('[role="group"][aria-label="GitHub"]')
    expect(group).not.toBeNull()
    expect(group?.textContent).not.toContain('No copy on this computer')
    const names = [...(group?.querySelectorAll('[role="option"]') ?? [])].map((option) =>
      option.getAttribute('aria-label')
    )
    expect(names).toContain('acme/infra, private, cloud only')
    expect(names).toContain('acme/site, cloud only')
    expect(group?.querySelectorAll('[data-cloud-only-badge]')).toHaveLength(2)
    type('')
  })
})
