// @vitest-environment happy-dom
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mission, MissionCreateResult, Project } from '../../../../shared/types'

const mocks = vi.hoisted(() => ({
  repos: [] as {
    id: string
    path: string
    displayName: string
    kind?: 'git' | 'folder'
    connectionId?: string | null
    executionHostId?: 'local' | `ssh:${string}` | `runtime:${string}` | null
  }[],
  projects: [] as Project[],
  projectGroups: [] as { id: string; name: string; parentGroupId: string | null }[],
  settings: null as {
    localWindowsRuntimeDefault: { kind: 'windows-host' } | { kind: 'wsl'; distro: string | null }
  } | null,
  addMissionMembers:
    vi.fn<(missionId: string, repoIds: string[]) => Promise<MissionCreateResult | null>>(),
  onOpenChange: vi.fn(),
  comboboxProps: [] as { repos: readonly { id: string }[] }[]
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: unknown) => unknown) =>
    selector({
      repos: mocks.repos,
      projects: mocks.projects,
      projectGroups: mocks.projectGroups,
      settings: mocks.settings,
      addMissionMembers: mocks.addMissionMembers
    })
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/repo-multi-combobox', () => ({
  default: (props: {
    repos: readonly { id: string }[]
    onChange: (next: ReadonlySet<string>) => void
  }) => {
    mocks.comboboxProps.push(props)
    return (
      <button
        type="button"
        data-testid="repo-picker"
        onClick={() => props.onChange(new Set([props.repos[0]?.id ?? '']))}
      >
        select project
      </button>
    )
  }
}))

vi.mock('@/lib/renderer-app-platform', () => ({
  getRendererAppPlatform: () => 'win32'
}))

import { MissionAddProjectsDialog } from './MissionAddProjectsDialog'

const MISSION: Mission = {
  id: 'mission-1',
  name: 'Native Mission',
  branchName: 'mission/native',
  members: [
    {
      repoId: 'existing',
      worktreeId: 'existing::/wt',
      worktreeInstanceId: 'instance-existing',
      lastError: null,
      addedAt: 1
    }
  ],
  tabOrder: 0,
  createdAt: 1,
  updatedAt: 1
}

let root: Root | null = null

function renderDialog(): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(<MissionAddProjectsDialog mission={MISSION} onOpenChange={mocks.onOpenChange} />)
  })
  return container
}

describe('MissionAddProjectsDialog', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    mocks.repos = []
    mocks.projects = []
    mocks.projectGroups = []
    mocks.settings = null
    mocks.addMissionMembers.mockReset()
    mocks.onOpenChange.mockReset()
    mocks.comboboxProps = []
  })

  afterEach(() => {
    if (root) {
      act(() => root?.unmount())
      root = null
    }
    document.body.replaceChildren()
  })

  it('explains the native-local Git limit and offers only new supported projects', () => {
    mocks.repos = [
      { id: 'existing', path: '/repos/existing', displayName: 'Existing' },
      { id: 'local', path: '/repos/local', displayName: 'Local' },
      { id: 'folder', path: '/repos/folder', displayName: 'Folder', kind: 'folder' },
      {
        id: 'legacy-ssh',
        path: '/srv/legacy',
        displayName: 'Legacy SSH',
        connectionId: 'target-1'
      },
      {
        id: 'ssh',
        path: '/srv/ssh',
        displayName: 'SSH',
        executionHostId: 'ssh:target-1'
      },
      {
        id: 'runtime',
        path: '/workspace/runtime',
        displayName: 'Runtime',
        executionHostId: 'runtime:env-1'
      },
      {
        id: 'wsl',
        path: '//wsl$/Ubuntu/repos/wsl',
        displayName: 'WSL',
        executionHostId: 'local'
      }
    ]

    const rendered = renderDialog()

    expect(rendered.textContent).toContain(
      "Missions currently support only Git projects on this computer's native filesystem"
    )
    expect(mocks.comboboxProps.at(-1)?.repos.map((repo) => repo.id)).toEqual(['local'])
  })

  it('applies Windows project and global WSL runtime settings to candidates', () => {
    mocks.repos = [
      { id: 'local', path: 'C:\\src\\local', displayName: 'Local' },
      { id: 'wsl-runtime', path: 'C:\\src\\wsl-runtime', displayName: 'WSL runtime' }
    ]
    mocks.projects = [
      {
        id: 'local-project',
        displayName: 'Local',
        badgeColor: '#000',
        localWindowsRuntimePreference: { kind: 'windows-host' },
        sourceRepoIds: ['local'],
        createdAt: 1,
        updatedAt: 1
      },
      {
        id: 'wsl-project',
        displayName: 'WSL runtime',
        badgeColor: '#000',
        sourceRepoIds: ['wsl-runtime'],
        createdAt: 1,
        updatedAt: 1
      }
    ]
    mocks.settings = {
      localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
    }

    renderDialog()

    expect(mocks.comboboxProps.at(-1)?.repos.map((repo) => repo.id)).toEqual(['local'])
  })

  it('keeps the dialog open and shows an error when adding projects resolves null', async () => {
    mocks.repos = [{ id: 'local', path: '/repos/local', displayName: 'Local' }]
    mocks.addMissionMembers.mockResolvedValue(null)
    const rendered = renderDialog()

    act(() => {
      rendered.querySelector<HTMLButtonElement>('[data-testid="repo-picker"]')?.click()
    })
    const addButton = Array.from(rendered.querySelectorAll('button')).find(
      (button) => button.textContent === 'Add'
    )
    expect(addButton).not.toBeUndefined()
    await act(async () => addButton?.click())

    expect(mocks.addMissionMembers).toHaveBeenCalledWith('mission-1', ['local'])
    expect(rendered.textContent).toContain('Could not add projects. Try again.')
    expect(mocks.onOpenChange).not.toHaveBeenCalled()
  })
})
