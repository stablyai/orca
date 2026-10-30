// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project } from '../../../../shared/project-types'

vi.mock('../ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children,
    disabled
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
    disabled?: boolean
  }) => (
    <select
      value={value}
      disabled={disabled}
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
vi.mock('./agent-launch-settings-transport', () => ({ readHostAgentLaunchSettings: vi.fn() }))

import { ProjectDefaultAgentSetting } from './ProjectDefaultAgentSetting'
import { toast } from 'sonner'
import { readHostAgentLaunchSettings } from './agent-launch-settings-transport'

const project: Project = {
  id: 'project-1',
  displayName: 'Project',
  badgeColor: '#000',
  sourceRepoIds: [],
  createdAt: 1,
  updatedAt: 1
}
let container: HTMLDivElement
let root: Root

function selectElement(): HTMLSelectElement {
  const element = container.querySelector('select')
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error('Default agent selector not found')
  }
  return element
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('ProjectDefaultAgentSetting', () => {
  it('shows a paired execution host global choice after loading it', async () => {
    vi.mocked(readHostAgentLaunchSettings).mockResolvedValueOnce({
      defaultTuiAgent: 'codex',
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      environmentNames: {},
      permissionMode: 'manual'
    })
    act(() =>
      root.render(
        <ProjectDefaultAgentSetting
          project={project}
          globalDefault="claude"
          executionHostId="runtime:remote"
          updateProject={vi.fn()}
        />
      )
    )
    expect(container.textContent).toContain('Loading target host global default')
    await act(async () => {
      await Promise.resolve()
    })
    expect(container.textContent).toContain('Codex')
  })

  it('shows the saved choice and inherited effective global choice', () => {
    act(() =>
      root.render(
        <ProjectDefaultAgentSetting
          project={project}
          globalDefault="claude"
          updateProject={vi.fn()}
        />
      )
    )
    expect(selectElement().value).toBe('inherit')
    expect(container.textContent).toContain('Claude')
    act(() =>
      root.render(
        <ProjectDefaultAgentSetting
          project={{ ...project, defaultTuiAgent: 'blank' }}
          globalDefault="claude"
          updateProject={vi.fn()}
        />
      )
    )
    expect(selectElement().value).toBe('blank')
  })

  it('reports a failed host save without showing the unsaved choice', async () => {
    const updateProject = vi.fn().mockResolvedValue(false)
    act(() =>
      root.render(
        <ProjectDefaultAgentSetting
          project={project}
          globalDefault={null}
          updateProject={updateProject}
        />
      )
    )
    await act(async () => {
      const select = selectElement()
      select.value = 'codex'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(updateProject).toHaveBeenCalledWith('project-1', { defaultTuiAgent: 'codex' })
    expect(selectElement().value).toBe('inherit')
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be saved')
    expect(toast.success).not.toHaveBeenCalled()
  })

  it('confirms successful saves only after the host accepts them', async () => {
    const updateProject = vi.fn().mockResolvedValue(true)
    act(() =>
      root.render(
        <ProjectDefaultAgentSetting
          project={project}
          globalDefault={null}
          updateProject={updateProject}
        />
      )
    )
    await act(async () => {
      const select = selectElement()
      select.value = 'blank'
      select.dispatchEvent(new Event('change', { bubbles: true }))
      await Promise.resolve()
    })
    expect(toast.success).toHaveBeenCalled()
  })

  it('retries a partial save after an acknowledged host already displays the requested value', async () => {
    const updateProject = vi
      .fn()
      .mockRejectedValueOnce(new Error('Saved on some hosts but not others. Retry the setting.'))
      .mockResolvedValueOnce(true)
    const render = (value: Project) =>
      root.render(
        <ProjectDefaultAgentSetting
          project={value}
          globalDefault={null}
          updateProject={updateProject}
        />
      )
    act(() => render(project))
    await act(async () => {
      const select = selectElement()
      select.value = 'codex'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    act(() => render({ ...project, defaultTuiAgent: 'codex' }))
    expect(selectElement().value).toBe('codex')
    expect(toast.success).not.toHaveBeenCalled()
    const retry = container.querySelector('button')
    if (!retry) {
      throw new Error('A partial save must offer a way to retry the same value')
    }
    await act(async () => retry.click())
    expect(updateProject).toHaveBeenCalledTimes(2)
    expect(updateProject).toHaveBeenLastCalledWith(project.id, { defaultTuiAgent: 'codex' })
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it('does not offer an old project save for retry after changing projects', async () => {
    const updateProject = vi.fn().mockRejectedValue(new Error('Partial save'))
    const render = (value: Project) =>
      root.render(
        <ProjectDefaultAgentSetting
          project={value}
          globalDefault={null}
          updateProject={updateProject}
        />
      )
    act(() => render(project))
    await act(async () => {
      const select = selectElement()
      select.value = 'codex'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(container.querySelector('button')).not.toBeNull()
    act(() => render({ ...project, id: 'other-project' }))
    expect(container.querySelector('[role="alert"]')).toBeNull()
    expect(container.querySelector('button')).toBeNull()
    expect(updateProject).toHaveBeenCalledTimes(1)
  })
})
