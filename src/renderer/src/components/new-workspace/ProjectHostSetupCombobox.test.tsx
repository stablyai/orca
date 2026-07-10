// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  NeedsSetupProjectHostOption,
  ProjectHostSetupOption
} from '@/lib/project-host-setup-options'
import ProjectHostSetupCombobox from './ProjectHostSetupCombobox'

vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/command', () => ({
  Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandList: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CommandItem: ({
    children,
    disabled,
    onSelect,
    value
  }: {
    children: React.ReactNode
    disabled?: boolean
    onSelect?: (value: string) => void
    value: string
  }) => (
    <button
      type="button"
      data-command-value={value}
      disabled={disabled}
      onClick={() => onSelect?.(value)}
    >
      {children}
    </button>
  )
}))

let container: HTMLDivElement
let root: Root

const readyOption: ProjectHostSetupOption = {
  id: 'local-setup',
  kind: 'ready',
  projectId: 'project-1',
  hostId: 'local',
  repoId: 'local-repo',
  label: 'Local Mac',
  detail: 'Orca',
  path: '/Users/alice/orca'
}

const needsSetupOption: NeedsSetupProjectHostOption = {
  id: 'needs-setup:ssh:builder',
  kind: 'needs-setup',
  projectId: 'project-1',
  hostId: 'ssh:builder',
  label: 'Builder',
  detail: 'Project not set up on this host',
  isAvailable: true
}

const unavailableOption: NeedsSetupProjectHostOption = {
  id: 'needs-setup:runtime:old',
  kind: 'needs-setup',
  projectId: 'project-1',
  hostId: 'runtime:old',
  label: 'Old server',
  detail: 'Update Orca on this host to set up projects',
  isAvailable: false
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

function renderCombobox({
  onValueChange = vi.fn()
}: {
  onValueChange?: (setupId: string) => void
} = {}): void {
  act(() => {
    root.render(
      <ProjectHostSetupCombobox
        options={[readyOption, needsSetupOption]}
        value={readyOption.id}
        onValueChange={onValueChange}
      />
    )
  })
}

describe('ProjectHostSetupCombobox', () => {
  it('routes ready setup rows through onValueChange', () => {
    const onValueChange = vi.fn()

    renderCombobox({ onValueChange })

    act(() => {
      container
        .querySelector<HTMLButtonElement>('[data-command-value="local-setup"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(onValueChange).toHaveBeenCalledWith('local-setup')
  })

  it('hides hosts that need setup from the run target list', () => {
    const onValueChange = vi.fn()

    renderCombobox({ onValueChange })

    expect(
      container.querySelector<HTMLButtonElement>('[data-command-value="needs-setup:ssh:builder"]')
    ).toBeNull()
    expect(container.textContent).not.toContain('Project not set up on this host')
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('hides unavailable setup rows from the run target list', () => {
    const onValueChange = vi.fn()

    act(() => {
      root.render(
        <ProjectHostSetupCombobox
          options={[readyOption, unavailableOption]}
          value={readyOption.id}
          onValueChange={onValueChange}
        />
      )
    })

    const unavailableButton = container.querySelector<HTMLButtonElement>(
      '[data-command-value="needs-setup:runtime:old"]'
    )
    expect(unavailableButton).toBeNull()
    expect(container.textContent).not.toContain('Update Orca on this host')

    expect(onValueChange).not.toHaveBeenCalled()
  })
})
