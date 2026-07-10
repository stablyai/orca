// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Project } from '../../../../shared/types'
import { ProjectWindowsRuntimeSetting } from './ProjectWindowsRuntimeSetting'

const project: Project = {
  id: 'project-1',
  displayName: 'Example Project',
  badgeColor: '#000000',
  sourceRepoIds: ['repo-1'],
  createdAt: 1,
  updatedAt: 1
}

function renderClient(props: React.ComponentProps<typeof ProjectWindowsRuntimeSetting>): {
  container: HTMLDivElement
  root: ReturnType<typeof createRoot>
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<ProjectWindowsRuntimeSetting {...props} />)
  })
  return { container, root }
}

function clickButton(container: HTMLElement, label: string): void {
  const button = Array.from(container.querySelectorAll('button')).find(
    (entry) => entry.textContent?.trim() === label
  )
  expect(button).toBeTruthy()
  act(() => {
    button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function cleanupClient(container: HTMLElement, root: ReturnType<typeof createRoot>): void {
  act(() => {
    root.unmount()
  })
  container.remove()
}

describe('ProjectWindowsRuntimeSetting', () => {
  it('describes the inherited global WSL runtime for a local Windows project', () => {
    const markup = renderToStaticMarkup(
      <ProjectWindowsRuntimeSetting
        project={project}
        settings={{
          ...getDefaultSettings('/tmp'),
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu-24.04' }
        }}
        isLocalWindowsProject
        wslAvailable
        wslDistros={['Ubuntu-24.04']}
        wslCapabilitiesLoading={false}
        updateProject={vi.fn()}
      />
    )

    expect(markup).toContain('Project runtime')
    expect(markup).toContain('No project override. General settings select Ubuntu-24.04 via WSL.')
    expect(markup).toContain('Existing terminals keep their current runtime.')
    expect(markup).toContain('Default (WSL)')
    expect(markup).toContain('Windows')
    expect(markup).toContain('WSL')
  })

  it('persists runtime override changes through the project update path', () => {
    const updateProject = vi.fn()
    const { container, root } = renderClient({
      project,
      settings: getDefaultSettings('/tmp'),
      isLocalWindowsProject: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04'],
      wslCapabilitiesLoading: false,
      updateProject
    })

    try {
      clickButton(container, 'Windows')
      expect(updateProject).toHaveBeenCalledWith('project-1', {
        localWindowsRuntimePreference: { kind: 'windows-host' }
      })

      clickButton(container, 'WSL')
      expect(updateProject).toHaveBeenCalledWith('project-1', {
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
      })

      act(() => {
        root.render(
          <ProjectWindowsRuntimeSetting
            project={{
              ...project,
              localWindowsRuntimePreference: { kind: 'windows-host' }
            }}
            settings={getDefaultSettings('/tmp')}
            isLocalWindowsProject
            wslAvailable
            wslDistros={['Ubuntu-24.04']}
            wslCapabilitiesLoading={false}
            updateProject={updateProject}
          />
        )
      })
      clickButton(container, 'Default (Windows)')
      expect(updateProject).toHaveBeenCalledWith('project-1', {
        localWindowsRuntimePreference: undefined
      })
    } finally {
      cleanupClient(container, root)
    }
  })

  it('shows the selected distro for explicit WSL project overrides', () => {
    const updateProject = vi.fn()
    const { container, root } = renderClient({
      project: {
        ...project,
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
      },
      settings: getDefaultSettings('/tmp'),
      isLocalWindowsProject: true,
      wslAvailable: true,
      wslDistros: ['Ubuntu-24.04', 'Debian'],
      wslCapabilitiesLoading: false,
      updateProject
    })

    try {
      expect(container.textContent).toContain('Ubuntu-24.04')
    } finally {
      cleanupClient(container, root)
    }
  })

  it('requires apply before switching runtime when live project sessions exist', () => {
    const updateProject = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)

    try {
      act(() => {
        root.render(
          <ProjectWindowsRuntimeSetting
            project={project}
            settings={getDefaultSettings('/tmp')}
            isLocalWindowsProject
            wslAvailable
            wslDistros={['Ubuntu-24.04']}
            wslCapabilitiesLoading={false}
            runtimeSessionSummary={{ liveTerminalCount: 1, activeTaskCount: 1 }}
            updateProject={updateProject}
          />
        )
      })

      const wslButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent?.trim() === 'WSL'
      )
      expect(wslButton).toBeTruthy()

      act(() => {
        wslButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(updateProject).not.toHaveBeenCalled()
      expect(container.textContent).toContain('Runtime change pending')

      const applyButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Apply runtime change')
      )
      expect(applyButton).toBeTruthy()

      act(() => {
        applyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(updateProject).toHaveBeenCalledWith('project-1', {
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
      })
    } finally {
      act(() => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('shows repair copy instead of silently falling back when a selected WSL distro is missing', () => {
    const markup = renderToStaticMarkup(
      <ProjectWindowsRuntimeSetting
        project={{
          ...project,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu-24.04' }
        }}
        settings={getDefaultSettings('/tmp')}
        isLocalWindowsProject
        wslAvailable
        wslDistros={['Debian']}
        wslCapabilitiesLoading={false}
        updateProject={vi.fn()}
      />
    )

    expect(markup).toContain('Ubuntu-24.04 is not installed in WSL.')
    expect(markup).toContain('Choose an installed distro or switch this project to Windows.')
  })

  it('does not render for remote or non-Windows-owned projects', () => {
    const markup = renderToStaticMarkup(
      <ProjectWindowsRuntimeSetting
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
})
