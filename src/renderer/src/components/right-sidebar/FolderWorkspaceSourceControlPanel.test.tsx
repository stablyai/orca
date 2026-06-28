// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo, Worktree, WorkspaceLineage } from '../../../../shared/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { TooltipProvider } from '@/components/ui/tooltip'
import FolderWorkspaceSourceControlPanel from './FolderWorkspaceSourceControlPanel'

type MockStoreState = {
  activeWorktreeId: string | null
  activeWorkspaceKey: string | null
  folderWorkspaces: { id: string; name: string; folderPath: string }[]
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  worktreeLineageById: Record<string, never>
  worktreesByRepo: Record<string, Worktree[]>
  repos: Repo[]
  gitStatusByWorktree: Record<string, unknown[]>
  sshConnectionStates: Map<string, { status?: string }>
  setGitStatus: () => void
  updateWorktreeGitIdentity: () => void
  setUpstreamStatus: () => void
  fetchUpstreamStatus: () => Promise<null>
}

const panelMocks = vi.hoisted(() => ({
  store: {} as MockStoreState,
  sourceControlProps: [] as { worktreeId?: string; embedded?: boolean }[],
  refreshCalls: [] as unknown[],
  invalidatedWorktreeIds: [] as string[],
  jumpToWorktreeCalls: [] as string[],
  keepRefreshPending: false
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    <T,>(selector: (state: MockStoreState) => T): T => selector(panelMocks.store),
    { getState: () => panelMocks.store }
  )
  return { useAppStore }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values ? fallback.replace('{{value0}}', String(values.value0)) : fallback
}))

vi.mock('@/lib/sidebar-worktree-activation', () => ({
  activateWorktreeFromSidebar: (worktreeId: string) => {
    panelMocks.jumpToWorktreeCalls.push(worktreeId)
  }
}))

vi.mock('./SourceControl', () => ({
  default: (props: { worktreeId?: string; embedded?: boolean }) => {
    panelMocks.sourceControlProps.push(props)
    return (
      <div data-testid="scoped-source-control" data-worktree-id={props.worktreeId}>
        SourceControl {props.worktreeId}
      </div>
    )
  }
}))

vi.mock('./folder-workspace-source-control-refresh', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    invalidateFolderSourceControlRefreshGeneration: (
      generationMap: Map<string, number>,
      worktreeIds: Iterable<string>
    ) => {
      const ids = [...worktreeIds]
      panelMocks.invalidatedWorktreeIds.push(...ids)
      const invalidate = actual.invalidateFolderSourceControlRefreshGeneration as (
        generationMap: Map<string, number>,
        worktreeIds: Iterable<string>
      ) => void
      invalidate(generationMap, ids)
    },
    runLimitedFolderSourceControlRefreshes: (args: unknown) => {
      panelMocks.refreshCalls.push(args)
      if (panelMocks.keepRefreshPending) {
        const refreshArgs = args as {
          candidates: { worktree: Worktree }[]
          inFlightWorktreeIds?: Map<string, number>
        }
        for (const candidate of refreshArgs.candidates) {
          refreshArgs.inFlightWorktreeIds?.set(candidate.worktree.id, 1)
        }
        return new Promise<void>(() => undefined)
      }
      return Promise.resolve()
    }
  }
})

let container: HTMLDivElement
let root: Root

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    ...overrides
  }
}

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    path: `/worktrees/${overrides.id}`,
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    repoId: 'repo-1',
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function makeWorkspaceLineage(child: Worktree, parentFolderId = 'folder-1'): WorkspaceLineage {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(child.id),
    childInstanceId: child.instanceId ?? null,
    parentWorkspaceKey: folderWorkspaceKey(parentFolderId),
    parentInstanceId: null,
    origin: 'cli',
    capture: { source: 'env-workspace', confidence: 'inferred' },
    createdAt: 1
  }
}

function renderPanel(children?: ReactNode): void {
  act(() => {
    root.render(
      <TooltipProvider>{children ?? <FolderWorkspaceSourceControlPanel />}</TooltipProvider>
    )
  })
}

describe('FolderWorkspaceSourceControlPanel', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    panelMocks.sourceControlProps = []
    panelMocks.refreshCalls = []
    panelMocks.invalidatedWorktreeIds = []
    panelMocks.jumpToWorktreeCalls = []
    panelMocks.keepRefreshPending = false
    panelMocks.store = {
      activeWorktreeId: folderWorkspaceKey('folder-1'),
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      folderWorkspaces: [{ id: 'folder-1', name: 'Platform folder', folderPath: '/platform' }],
      workspaceLineageByChildKey: {},
      worktreeLineageById: {},
      worktreesByRepo: {},
      repos: [makeRepo()],
      gitStatusByWorktree: {},
      sshConnectionStates: new Map(),
      setGitStatus: vi.fn(),
      updateWorktreeGitIdentity: vi.fn(),
      setUpstreamStatus: vi.fn(),
      fetchUpstreamStatus: vi.fn().mockResolvedValue(null)
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows unavailable copy outside folder workspaces', () => {
    panelMocks.store.activeWorktreeId = 'repo-1::/current'
    panelMocks.store.activeWorkspaceKey = 'repo-1::/current'

    renderPanel()

    expect(container.textContent).toContain(
      'Source Control is only shown for folder workspaces with attached worktrees.'
    )
    expect(panelMocks.sourceControlProps).toEqual([])
  })

  it('shows an empty state for a folder workspace with no attached worktrees', () => {
    renderPanel()

    expect(container.textContent).toContain('Platform folder')
    expect(container.textContent).toContain('No attached worktrees yet')
    expect(panelMocks.sourceControlProps).toEqual([])
  })

  it('mounts SourceControl only for expanded sections and scopes it to the child worktree', () => {
    const first = makeWorktree({
      id: 'repo-1::/first',
      displayName: 'First child',
      instanceId: 'first',
      lastActivityAt: 20
    })
    const second = makeWorktree({
      id: 'repo-1::/second',
      displayName: 'Second child',
      instanceId: 'second',
      lastActivityAt: 10
    })
    panelMocks.store.worktreesByRepo = { 'repo-1': [first, second] }
    panelMocks.store.workspaceLineageByChildKey = {
      [first.id]: makeWorkspaceLineage(first),
      [second.id]: makeWorkspaceLineage(second)
    }
    panelMocks.store.gitStatusByWorktree = {
      [first.id]: [{ path: 'a.ts' }],
      [second.id]: [{ path: 'b.ts' }, { path: 'c.ts' }]
    }

    renderPanel()

    expect(container.textContent).toContain('2 attached worktrees')
    expect(container.textContent).toContain('First child')
    expect(container.textContent).toContain('Second child')
    expect(container.textContent).toContain('1 cached')
    expect(container.textContent).toContain('2 cached')
    expect(panelMocks.sourceControlProps).toEqual([{ worktreeId: first.id, embedded: true }])

    const secondButton = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Second child')
    )
    expect(secondButton).not.toBeNull()
    act(() => {
      secondButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(panelMocks.sourceControlProps).toContainEqual({
      worktreeId: second.id,
      embedded: true
    })
    expect(container.querySelectorAll('[data-testid="scoped-source-control"]')).toHaveLength(2)
  })

  it('invalidates pending refresh generations when the panel unmounts', () => {
    const child = makeWorktree({
      id: 'repo-1::/first',
      displayName: 'First child',
      instanceId: 'first',
      lastActivityAt: 20
    })
    panelMocks.store.worktreesByRepo = { 'repo-1': [child] }
    panelMocks.store.workspaceLineageByChildKey = {
      [child.id]: makeWorkspaceLineage(child)
    }

    renderPanel()
    expect(panelMocks.refreshCalls.length).toBeGreaterThan(0)

    renderPanel(<div />)

    expect(panelMocks.invalidatedWorktreeIds).toContain(child.id)
  })

  it('releases cancelled refresh reservations so dependency reruns can retry', () => {
    const child = makeWorktree({
      id: 'repo-1::/first',
      displayName: 'First child',
      instanceId: 'first',
      lastActivityAt: 20
    })
    panelMocks.keepRefreshPending = true
    panelMocks.store.worktreesByRepo = { 'repo-1': [child] }
    panelMocks.store.workspaceLineageByChildKey = {
      [child.id]: makeWorkspaceLineage(child)
    }

    renderPanel()
    const initialCallCount = panelMocks.refreshCalls.length

    panelMocks.store.sshConnectionStates = new Map([['ssh-target', { status: 'connected' }]])
    renderPanel()

    expect(panelMocks.invalidatedWorktreeIds).toContain(child.id)
    expect(panelMocks.refreshCalls.length).toBeGreaterThan(initialCallCount)
  })

  it('uses the host-matching repo name for duplicate repo ids', () => {
    const child = makeWorktree({
      id: 'repo-1::/ssh-child',
      displayName: 'SSH child',
      hostId: 'ssh:ssh-target',
      instanceId: 'ssh-child',
      lastActivityAt: 20
    })
    panelMocks.store.repos = [
      makeRepo({ displayName: 'Local Repo', executionHostId: 'local' }),
      makeRepo({
        displayName: 'SSH Repo',
        connectionId: 'ssh-target',
        executionHostId: 'ssh:ssh-target'
      })
    ]
    panelMocks.store.worktreesByRepo = { 'repo-1': [child] }
    panelMocks.store.workspaceLineageByChildKey = {
      [child.id]: makeWorkspaceLineage(child)
    }

    renderPanel()

    expect(container.textContent).toContain('SSH Repo')
  })

  it('jumps to a child worktree from the section header without collapsing it', () => {
    const child = makeWorktree({
      id: 'repo-1::/first',
      displayName: 'First child',
      instanceId: 'first',
      lastActivityAt: 20
    })
    panelMocks.store.worktreesByRepo = { 'repo-1': [child] }
    panelMocks.store.workspaceLineageByChildKey = {
      [child.id]: makeWorkspaceLineage(child)
    }

    renderPanel()

    const jumpButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Jump to worktree"]'
    )
    expect(jumpButton).not.toBeNull()

    act(() => {
      jumpButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(panelMocks.jumpToWorktreeCalls).toEqual([child.id])
    expect(container.querySelectorAll('[data-testid="scoped-source-control"]')).toHaveLength(1)
  })
})
