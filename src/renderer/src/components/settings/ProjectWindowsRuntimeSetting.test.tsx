// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Project } from '../../../../shared/project-types'
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

  it('drops a pending runtime change when the storage lock engages', () => {
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
            wslDistros={['Ubuntu-24.04', 'Debian']}
            wslCapabilitiesLoading={false}
            runtimeSessionSummary={{ liveTerminalCount: 1, activeTaskCount: 1 }}
            updateProject={updateProject}
          />
        )
      })

      clickButton(container, 'WSL')
      expect(container.textContent).toContain('Runtime change pending')

      // Why: moving the project onto \\wsl.localhost\Debian must lock the runtime
      // and retire the half-made pending choice — not leave both on screen.
      act(() => {
        root.render(
          <ProjectWindowsRuntimeSetting
            project={project}
            settings={getDefaultSettings('/tmp')}
            isLocalWindowsProject
            repoPath="\\wsl.localhost\Debian\home\u\sample-project"
            wslAvailable
            wslDistros={['Ubuntu-24.04', 'Debian']}
            wslCapabilitiesLoading={false}
            runtimeSessionSummary={{ liveTerminalCount: 1, activeTaskCount: 1 }}
            updateProject={updateProject}
          />
        )
      })

      expect(container.textContent).not.toContain('Runtime change pending')
      expect(container.textContent).toContain('runtime is locked to that distro')
    } finally {
      act(() => {
        root.unmount()
      })
      container.remove()
    }
  })

  it('refuses to commit a pending change while the storage lock is active', () => {
    const updateProject = vi.fn().mockResolvedValue(true)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    // Why windows-host: a stored preference that contradicts the lock makes the
    // mount effect normalize once, so a second updateProject can only come from
    // an Apply the guard must block.
    const lockedProject: Project = {
      ...project,
      localWindowsRuntimePreference: { kind: 'windows-host' }
    }

    try {
      act(() => {
        root.render(
          <ProjectWindowsRuntimeSetting
            project={lockedProject}
            settings={getDefaultSettings('/tmp')}
            isLocalWindowsProject
            repoPath="\\wsl.localhost\Debian\home\u\sample-project"
            wslAvailable
            wslDistros={['Debian']}
            wslCapabilitiesLoading={false}
            runtimeSessionSummary={{ liveTerminalCount: 1, activeTaskCount: 0 }}
            updateProject={updateProject}
          />
        )
      })

      // The mount effect normalizes the contradicting stored preference once.
      expect(updateProject).toHaveBeenCalledTimes(1)

      clickButton(container, 'WSL')
      // Why assert first: without a rendered Apply button the test would pass
      // vacuously, never exercising the commit guard it exists to pin.
      const applyButton = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Apply runtime change')
      )
      expect(applyButton).toBeTruthy()
      act(() => {
        applyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      // Why still 1: the lock guard no-ops the commit, so Apply adds no update.
      expect(updateProject).toHaveBeenCalledTimes(1)
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

  it('locks the runtime to the storage distro for projects on a WSL UNC path', () => {
    vi.useFakeTimers()
    const updateProject = vi.fn()
    const { container, root } = renderClient({
      project,
      settings: getDefaultSettings('/tmp'),
      isLocalWindowsProject: true,
      repoPath: '\\\\wsl.localhost\\Debian\\home\\u\\sample-project',
      wslAvailable: true,
      wslDistros: ['Debian'],
      wslCapabilitiesLoading: false,
      updateProject
    })

    try {
      act(() => {
        vi.runAllTimers()
      })
      // Why: storage and execution must agree — the selector locks to the
      // storage distro and normalizes a contradicting stored preference.
      expect(updateProject).toHaveBeenCalledWith('project-1', {
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Debian' }
      })
      expect(container.textContent).toContain('runtime is locked to that distro')
      // Why aria-disabled: a native disabled button leaves the tab order (see
      // SettingsFormControls), so the segments disable via aria-disabled.
      const disabledButtons = Array.from(
        container.querySelectorAll('button[aria-disabled="true"]')
      ).map((button) => button.textContent?.trim())
      expect(disabledButtons).toContain('Windows')
      expect(disabledButtons).toContain('Default (Windows)')
    } finally {
      cleanupClient(container, root)
      vi.useRealTimers()
    }
  })

  it('keeps the runtime switchable when the storage distro is no longer installed', () => {
    const markup = renderToStaticMarkup(
      <ProjectWindowsRuntimeSetting
        project={project}
        settings={getDefaultSettings('/tmp')}
        isLocalWindowsProject
        repoPath="\\wsl.localhost\gone\home\u\proj"
        wslAvailable
        wslDistros={['Ubuntu-24.04']}
        wslCapabilitiesLoading={false}
        updateProject={vi.fn()}
      />
    )

    expect(markup).not.toContain('runtime is locked to that distro')
    expect(markup).not.toContain('aria-disabled="true"')
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
