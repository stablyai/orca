// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Project } from '../../../../shared/types'
import { ProjectDefaultShellSetting } from './ProjectDefaultShellSetting'

const project: Project = {
  id: 'project-1',
  displayName: 'Example Project',
  badgeColor: '#000000',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
  if (element.props?.control) {
    visit(element.props.control, cb)
  }
}

function findShellSelect(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (typeof entry.props.onValueChange === 'function') {
      found = entry
    }
  })
  if (!found) {
    throw new Error('default shell select not found')
  }
  return found
}

function renderSetting(
  props: React.ComponentProps<typeof ProjectDefaultShellSetting>
): React.JSX.Element | null {
  return ProjectDefaultShellSetting(props)
}

describe('ProjectDefaultShellSetting', () => {
  it('describes the default shell control for a windows-host project', () => {
    const markup = renderToStaticMarkup(
      <ProjectDefaultShellSetting
        project={project}
        settings={getDefaultSettings('/tmp')}
        isLocalWindowsProject
        wslAvailable
        wslDistros={['Ubuntu-24.04']}
        wslCapabilitiesLoading={false}
        updateProject={vi.fn()}
      />
    )

    expect(markup).toContain('Default shell')
    expect(markup).toContain('Shell used when opening new terminals for this project.')
  })

  it('shows the selected shell label once mounted', () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(
          <ProjectDefaultShellSetting
            project={{ ...project, defaultShell: 'powershell' }}
            settings={getDefaultSettings('/tmp')}
            isLocalWindowsProject
            wslAvailable
            wslDistros={['Ubuntu-24.04']}
            wslCapabilitiesLoading={false}
            updateProject={vi.fn()}
          />
        )
      })

      expect(container.textContent).toContain('PowerShell')
    } finally {
      act(() => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('reflects an existing shell override as the selected value', () => {
    const element = renderSetting({
      project: { ...project, defaultShell: 'git-bash' },
      settings: getDefaultSettings('/tmp'),
      isLocalWindowsProject: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04'],
      wslCapabilitiesLoading: false,
      updateProject: vi.fn()
    })

    expect(findShellSelect(element).props.value).toBe('git-bash')
  })

  it('writes the selected shell through the project update path', () => {
    const updateProject = vi.fn()
    const element = renderSetting({
      project,
      settings: getDefaultSettings('/tmp'),
      isLocalWindowsProject: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04'],
      wslCapabilitiesLoading: false,
      updateProject
    })
    const onValueChange = findShellSelect(element).props.onValueChange as (value: string) => void

    onValueChange('powershell')

    expect(updateProject).toHaveBeenCalledWith('project-1', { defaultShell: 'powershell' })
  })

  it('clears the override when switching back to the global default', () => {
    const updateProject = vi.fn()
    const element = renderSetting({
      project: { ...project, defaultShell: 'cmd' },
      settings: getDefaultSettings('/tmp'),
      isLocalWindowsProject: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04'],
      wslCapabilitiesLoading: false,
      updateProject
    })
    const onValueChange = findShellSelect(element).props.onValueChange as (value: string) => void

    onValueChange('inherit')

    expect(updateProject).toHaveBeenCalledWith('project-1', { defaultShell: undefined })
  })

  it('disables the control for a project overridden to run in WSL', () => {
    const wslProject: Project = {
      ...project,
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
    }
    const markup = renderToStaticMarkup(
      <ProjectDefaultShellSetting
        project={wslProject}
        settings={getDefaultSettings('/tmp')}
        isLocalWindowsProject
        wslAvailable
        wslDistros={['Ubuntu-24.04']}
        wslCapabilitiesLoading={false}
        updateProject={vi.fn()}
      />
    )
    const element = renderSetting({
      project: wslProject,
      settings: getDefaultSettings('/tmp'),
      isLocalWindowsProject: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04'],
      wslCapabilitiesLoading: false,
      updateProject: vi.fn()
    })

    expect(findShellSelect(element).props.disabled).toBe(true)
    expect(markup).toContain('This project runs in WSL, which always uses the WSL shell.')
  })

  it('disables the control for a project that inherits a WSL global default', () => {
    const element = renderSetting({
      project,
      settings: {
        ...getDefaultSettings('/tmp'),
        localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu-24.04' }
      },
      isLocalWindowsProject: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04'],
      wslCapabilitiesLoading: false,
      updateProject: vi.fn()
    })

    expect(findShellSelect(element).props.disabled).toBe(true)
  })

  it('does not render for remote or non-Windows-owned projects', () => {
    const markup = renderToStaticMarkup(
      <ProjectDefaultShellSetting
        project={project}
        settings={getDefaultSettings('/tmp')}
        isLocalWindowsProject={false}
        wslAvailable
        wslDistros={['Ubuntu-24.04']}
        wslCapabilitiesLoading={false}
        updateProject={vi.fn()}
      />
    )

    expect(markup).toBe('')
  })

  it('does not render without a project', () => {
    const markup = renderToStaticMarkup(
      <ProjectDefaultShellSetting
        project={null}
        settings={getDefaultSettings('/tmp')}
        isLocalWindowsProject
        wslAvailable
        wslDistros={['Ubuntu-24.04']}
        wslCapabilitiesLoading={false}
        updateProject={vi.fn()}
      />
    )

    expect(markup).toBe('')
  })
})
