// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { WorktreeLayoutSetting } from './WorktreeLayoutSetting'
import { buildWorktreeLayoutExamplePath } from './worktree-layout-example-path'

vi.mock('../../store', () => ({
  useAppStore: (selector: (state: { settingsSearchQuery: string }) => unknown) =>
    selector({ settingsSearchQuery: '' })
}))

vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select
      aria-label="Workspace Layout"
      value={value}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

type LayoutSettings = Pick<GlobalSettings, 'workspaceDir' | 'nestWorkspaces' | 'worktreeLayout'>

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

function render(settings: LayoutSettings, updateSettings = vi.fn()): typeof updateSettings {
  act(() => {
    root.render(<WorktreeLayoutSetting settings={settings} updateSettings={updateSettings} />)
  })
  return updateSettings
}

function select(): HTMLSelectElement {
  const element = container.querySelector('select')
  if (!element) {
    throw new Error('layout select not rendered')
  }
  return element
}

function choose(value: string): void {
  act(() => {
    select().value = value
    select().dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('WorktreeLayoutSetting', () => {
  it('shows the layout a legacy profile derives from nestWorkspaces', () => {
    render({ workspaceDir: '/home/dev/orca/workspaces', nestWorkspaces: false })

    expect(select().value).toBe('flat')
    expect(container.textContent).toContain('…/orca/workspaces/feature')
  })

  it('lists an example path for every layout', () => {
    render({ workspaceDir: '/home/dev/orca/workspaces', nestWorkspaces: true })

    const options = [...container.querySelectorAll('option')].map((option) => [
      option.value,
      option.textContent
    ])
    expect(options).toEqual([
      ['nested', 'Nested…/orca/workspaces/my-repo/feature'],
      ['flat', 'Flat…/orca/workspaces/feature'],
      ['sibling', 'Next to repository…/my-repo.worktrees/feature']
    ])
  })

  it('writes the layout together with the legacy boolean older builds read', () => {
    const updateSettings = render({ workspaceDir: '/ws', nestWorkspaces: true })

    choose('sibling')
    expect(updateSettings).toHaveBeenLastCalledWith({
      worktreeLayout: 'sibling',
      nestWorkspaces: true
    })

    choose('flat')
    expect(updateSettings).toHaveBeenLastCalledWith({
      worktreeLayout: 'flat',
      nestWorkspaces: false
    })
  })

  it('does not write when the current layout is picked again', () => {
    const updateSettings = render({
      workspaceDir: '/ws',
      nestWorkspaces: true,
      worktreeLayout: 'sibling'
    })

    choose('sibling')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Ignores the workspace directory')
  })
})

describe('buildWorktreeLayoutExamplePath', () => {
  it('keeps short roots and shortens long ones on every platform', () => {
    expect(buildWorktreeLayoutExamplePath('nested', '.orca/worktrees')).toBe(
      '.orca/worktrees/my-repo/feature'
    )
    expect(buildWorktreeLayoutExamplePath('flat', '/wt/')).toBe('/wt/feature')
    expect(buildWorktreeLayoutExamplePath('nested', 'C:\\Users\\dev\\orca\\workspaces')).toBe(
      '…\\orca\\workspaces\\my-repo\\feature'
    )
    expect(buildWorktreeLayoutExamplePath('sibling', 'C:\\ws')).toBe(
      '…\\my-repo.worktrees\\feature'
    )
  })
})
