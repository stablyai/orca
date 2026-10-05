// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  UnifiedProjectGroup,
  UnifiedSessionRow,
  UnifiedWorktreeRow
} from './resource-usage-merge-types'

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
    activeWorkspaceExecutionHostId: 'runtime:paired'
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

const originalWorktrees = mocks.state.worktreesByRepo

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
    mocks.state.worktreesByRepo = originalWorktrees
  })

  it.each(['ssh:box', 'runtime:paired'])(
    'renders local sampled metadata and qualified actions with a %s twin',
    (hostId) => {
      mocks.state.worktreesByRepo = {
        repo: [
          {
            id: 'repo::/same',
            repoId: 'repo',
            hostId,
            displayName: 'Remote twin',
            isMainWorktree: false
          },
          {
            id: 'repo::/same',
            repoId: 'repo',
            hostId: 'local',
            displayName: 'Saved local',
            isMainWorktree: false
          }
        ]
      }
      const sessions: UnifiedSessionRow[] = [true, false].map((hasLocalSamples) => ({
        sessionId: hasLocalSamples ? 'sampled' : 'ssh-session',
        paneKey: null,
        pid: 1,
        label: 'Terminal',
        bound: false,
        agentOwnership: hasLocalSamples ? 'unknown' : 'present',
        tabId: null,
        cpu: hasLocalSamples ? 1 : null,
        memory: hasLocalSamples ? 100 : null,
        hasLocalSamples
      }))
      const sampled = {
        ...row('repo::/same', 'Snapshot name', 'repo'),
        hasLocalSamples: true,
        sessions
      }
      const navigateToWorktree = vi.fn()
      const onDelete = vi.fn()
      const onKillSession = vi.fn()
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      act(() =>
        root.render(
          <ResourceTree
            repos={[{ ...repos[0], worktrees: [sampled] }]}
            activeHostId="local"
            sortOption="name"
            collapsedRepos={new Set()}
            toggleRepo={() => {}}
            collapsedWorktrees={new Set()}
            activeWorktreeId={null}
            toggleWorktree={() => {}}
            navigateToWorktree={navigateToWorktree}
            navigateToTab={() => {}}
            onDelete={onDelete}
            onKillSession={onKillSession}
            readOnly={false}
          />
        )
      )
      const resume = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Resume workspace Saved local"]'
      )
      const remove = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Delete workspace Saved local"]'
      )
      expect(resume).not.toBeNull()
      expect(remove).not.toBeNull()
      act(() => {
        resume?.click()
        remove?.click()
      })
      expect(navigateToWorktree).toHaveBeenCalledWith('repo::/same', 'local')
      expect(onDelete).toHaveBeenCalledWith('repo::/same', 'local')
      expect(onKillSession).not.toHaveBeenCalled()
      act(() =>
        container
          .querySelector<HTMLButtonElement>('button[aria-label="Kill session ssh-session"]')
          ?.click()
      )
      expect(onKillSession).toHaveBeenCalledWith(sessions[1])
      expect(sessions[1]).toMatchObject({ hasLocalSamples: false, agentOwnership: 'present' })
    }
  )

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
    expect(navigateToWorktree).toHaveBeenNthCalledWith(1, 'repo::/ssh', undefined)
    expect(navigateToWorktree).toHaveBeenNthCalledWith(2, 'folder:ssh-folder', undefined)
  })
})
