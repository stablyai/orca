// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { UnifiedProjectGroup, UnifiedWorktreeRow } from './resource-usage-merge-types'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mocks = vi.hoisted(() => ({
  state: {
    worktreesByRepo: {
      repo: [
        {
          id: 'repo::/ssh',
          repoId: 'repo',
          hostId: 'ssh:box',
          displayName: 'Catalog SSH git',
          isMainWorktree: false
        }
      ]
    },
    detectedWorktreesByRepo: {},
    folderWorkspaces: [
      {
        id: 'ssh-folder',
        projectGroupId: 'folders',
        name: 'Catalog SSH folder',
        folderPath: '/srv/folder',
        connectionId: 'box',
        executionHostId: 'ssh:box',
        diffComments: []
      }
    ],
    projectGroups: [],
    repos: [],
    settings: null,
    runtimeEnvironments: [],
    runtimeEnvironmentCatalogHydrated: true,
    removedRuntimeEnvironmentIds: new Set<string>(),
    restoredRuntimeHostIdByWorkspaceSessionKey: {},
    activeWorktreeId: null,
    activeWorkspaceExecutionHostId: null
  }
}))

vi.mock('../../store', () => {
  const useAppStore = Object.assign(
    (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
    { getState: () => mocks.state }
  )
  return { useAppStore }
})

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    values
      ? Object.entries(values).reduce(
          (text, [token, value]) => text.replace(`{{${token}}}`, value),
          fallback
        )
      : fallback
}))

import { ResourceTree } from './resource-usage-resource-tree'

function row(worktreeId: string, worktreeName: string, repoId: string): UnifiedWorktreeRow {
  return {
    worktreeId,
    worktreeName,
    repoId,
    repoName: 'Resources',
    cpu: null,
    memory: null,
    history: [],
    hasLocalSamples: false,
    isRemote: true,
    sessions: [],
    browsers: []
  }
}

const repos: UnifiedProjectGroup[] = [
  {
    repoId: 'resources',
    repoName: 'Resources',
    cpu: null,
    memory: null,
    hasRemoteChildren: true,
    worktrees: [
      row('repo::/ssh', 'Snapshot SSH git', 'repo'),
      row('folder:ssh-folder', 'Snapshot SSH folder', 'folder-workspace:folders')
    ]
  }
]

describe('Resource Manager local collector rows', () => {
  let container: HTMLDivElement
  let root: Root

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders SSH git and folder resume controls with owner catalog metadata', () => {
    const navigateToWorktree = vi.fn()
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    act(() => {
      root.render(
        <ResourceTree
          repos={repos}
          activeHostId="local"
          sortOption="name"
          collapsedRepos={new Set()}
          toggleRepo={() => {}}
          collapsedWorktrees={new Set()}
          activeWorktreeId={null}
          toggleWorktree={() => {}}
          navigateToWorktree={navigateToWorktree}
          navigateToTab={() => {}}
          onDelete={() => {}}
          onKillSession={() => {}}
          readOnly={false}
        />
      )
    })

    const gitButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Resume workspace Catalog SSH git"]'
    )
    const folderButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Resume workspace Catalog SSH folder"]'
    )
    expect(gitButton).not.toBeNull()
    expect(folderButton).not.toBeNull()

    act(() => {
      gitButton?.click()
      folderButton?.click()
    })
    expect(navigateToWorktree).toHaveBeenNthCalledWith(1, 'repo::/ssh')
    expect(navigateToWorktree).toHaveBeenNthCalledWith(2, 'folder:ssh-folder')
  })
})
