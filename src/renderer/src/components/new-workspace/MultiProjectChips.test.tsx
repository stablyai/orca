// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectHostSetup } from '../../../../shared/project-types'
import MultiProjectChips from './MultiProjectChips'
import { resolveSelectedProjects } from './resolve-project-setup-for-host'

let container: HTMLDivElement
let root: Root

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

function setup(projectId: string, patch: Partial<ProjectHostSetup> = {}): ProjectHostSetup {
  return {
    id: `${projectId}-${patch.hostId ?? 'local'}`,
    projectId,
    hostId: 'local',
    repoId: `repo-${projectId}`,
    path: `/code/${projectId}`,
    displayName: projectId,
    kind: 'git',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1,
    ...patch
  }
}

const projects = [
  { projectId: 'api', displayName: 'api', badgeColor: '#111' },
  { projectId: 'web', displayName: 'web', badgeColor: '#222' }
]

describe('MultiProjectChips', () => {
  it('keeps a project without a setup as an error chip with the reason in text', () => {
    const setups = [setup('api', { hostId: 'runtime:a' })]
    act(() => {
      root.render(
        <MultiProjectChips
          projects={projects}
          resolutions={resolveSelectedProjects(['api', 'web'], 'runtime:a', setups)}
          hostLabel="build-box"
          onRemoveProject={vi.fn()}
          onChooseSetup={vi.fn()}
        />
      )
    })
    expect(container.querySelectorAll('li')).toHaveLength(2)
    expect(container.querySelector('[role="status"]')?.textContent).toBe('No setup on build-box')
    expect(container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(1)
  })

  it('shows the setup only when two setups are eligible and removes by project id', () => {
    const onRemove = vi.fn()
    const setups = [
      setup('api'),
      setup('api', { id: 'api-2', displayName: 'api-fork', createdAt: 9 })
    ]
    act(() => {
      root.render(
        <MultiProjectChips
          projects={[projects[0]]}
          resolutions={resolveSelectedProjects(['api'], 'local', setups)}
          hostLabel="This computer"
          onRemoveProject={onRemove}
          onChooseSetup={vi.fn()}
        />
      )
    })
    expect(container.textContent).toContain('api')
    const buttons = Array.from(container.querySelectorAll('button'))
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Choose the setup for api',
      'Remove api'
    ])
    act(() => {
      buttons[1].click()
    })
    expect(onRemove).toHaveBeenCalledWith('api')
  })

  it('shows no setup control when the project has a single setup', () => {
    act(() => {
      root.render(
        <MultiProjectChips
          projects={[projects[0]]}
          resolutions={resolveSelectedProjects(['api'], 'local', [setup('api')])}
          hostLabel="This computer"
          onRemoveProject={vi.fn()}
          onChooseSetup={vi.fn()}
        />
      )
    })
    expect(container.querySelectorAll('button')).toHaveLength(1)
  })
})
