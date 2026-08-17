// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Project } from '../../../../shared/project-types'
import { ProjectTerminalBackendSetting } from './ProjectTerminalBackendSetting'

describe('ProjectTerminalBackendSetting', () => {
  it('persists a project Herdr override while showing the active backend separately', () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000000',
      terminalBackendByHost: { local: { backend: 'orca', state: 'ready' } },
      sourceRepoIds: ['repo-1'],
      createdAt: 1,
      updatedAt: 1
    }
    const updateProject = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <ProjectTerminalBackendSetting
          project={project}
          hostId="local"
          settings={getDefaultSettings('/tmp')}
          updateProject={updateProject}
        />
      )
    })

    expect(container.textContent).toContain('Active: Orca')
    const herdr = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Herdr'
    )
    act(() => herdr?.click())
    expect(updateProject).toHaveBeenCalledWith('project-1', {
      terminalBackendPreference: 'herdr'
    })

    act(() => root.unmount())
  })

  it('blocks Orca to Herdr migration while legacy terminals are live', () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000000',
      sourceRepoIds: ['repo-1'],
      createdAt: 1,
      updatedAt: 1,
      terminalBackendByHost: { local: { backend: 'orca', state: 'ready' } }
    }
    const updateProject = vi.fn()
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <ProjectTerminalBackendSetting
          project={project}
          hostId="local"
          settings={getDefaultSettings('/tmp')}
          runtimeSessionSummary={{ liveTerminalCount: 2, activeTaskCount: 0 }}
          updateProject={updateProject}
        />
      )
    })

    const herdr = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Herdr'
    )
    act(() => herdr?.click())

    expect(updateProject).not.toHaveBeenCalled()
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      'Close the 2 live Orca terminals'
    )
    act(() => root.unmount())
  })
})
