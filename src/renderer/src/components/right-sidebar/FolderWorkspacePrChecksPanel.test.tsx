// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  FolderWorkspace,
  PRCheckDetail,
  Repo,
  Worktree,
  WorkspaceLineage
} from '../../../../shared/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import { getHostedReviewCacheKey } from '@/store/slices/hosted-review'
import { getGitHubRepoCacheKey } from '@/store/slices/github-cache-key'
import { prChecksCacheSuffix } from '@/store/slices/github'

type MockStoreState = {
  activeWorktreeId: string | null
  activeWorkspaceKey: string | null
  folderWorkspaces: FolderWorkspace[]
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
  worktreeLineageById: Record<string, never>
  worktreesByRepo: Record<string, Worktree[]>
  repos: Repo[]
  settings: null
  hostedReviewCache: Record<string, { data: HostedReviewInfo | null; fetchedAt: number }>
  prCache: Record<string, never>
  checksCache: Record<string, { data: PRCheckDetail[]; fetchedAt: number; headSha?: string }>
  fetchHostedReviewForBranch: ReturnType<typeof vi.fn>
  fetchPRChecks: ReturnType<typeof vi.fn>
  fetchPRCheckDetails: ReturnType<typeof vi.fn>
  setActiveWorktree: ReturnType<typeof vi.fn>
  setRightSidebarTab: ReturnType<typeof vi.fn>
}

const mockState = vi.hoisted(() => ({
  store: {} as MockStoreState,
  openedLinks: [] as string[]
}))

vi.mock('@/store', () => ({
  useAppStore: <T,>(selector: (state: MockStoreState) => T): T => selector(mockState.store)
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) =>
    values ? fallback.replace('{{value0}}', String(values.value0)) : fallback
}))

vi.mock('@/lib/http-link-routing', () => ({
  openHttpLink: (url: string) => {
    mockState.openedLinks.push(url)
  }
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('./checks-panel-content', () => ({
  CHECK_COLOR: {
    success: 'success',
    failure: 'failure',
    pending: 'pending',
    neutral: 'neutral'
  },
  CHECK_ICON: {
    success: (props: { className?: string }) => <span data-icon="success" {...props} />,
    failure: (props: { className?: string }) => <span data-icon="failure" {...props} />,
    pending: (props: { className?: string }) => <span data-icon="pending" {...props} />,
    neutral: (props: { className?: string }) => <span data-icon="neutral" {...props} />
  },
  PullRequestIcon: (props: { className?: string }) => <span data-icon="review" {...props} />,
  prStateColor: () => 'state-color',
  ChecksList: ({ checks, checksLoading }: { checks: PRCheckDetail[]; checksLoading: boolean }) => (
    <div data-testid="checks-list">
      {checksLoading ? 'Loading checks' : null}
      {checks.map((check) => (
        <div key={check.name}>{check.name}</div>
      ))}
    </div>
  )
}))

import FolderWorkspacePrChecksPanel from './FolderWorkspacePrChecksPanel'

let container: HTMLDivElement
let root: Root

function makeFolder(): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId: 'project-group-1',
    name: 'Folder parent',
    folderPath: '/folder',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    createdAt: 0,
    updatedAt: 0
  }
}

function makeRepo(): Repo {
  return {
    id: 'repo-1',
    path: '/repo',
    displayName: 'Repo',
    badgeColor: '#fff',
    addedAt: 1,
    kind: 'git'
  }
}

function makeWorktree(): Worktree {
  return {
    id: 'repo-1::/child',
    path: '/child',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    repoId: 'repo-1',
    displayName: 'Child worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: 12,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeReview(): HostedReviewInfo {
  return {
    provider: 'github',
    number: 12,
    title: 'Review title',
    state: 'open',
    url: 'https://example.test/pr/12',
    status: 'success',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergeable: 'MERGEABLE',
    headSha: 'abc'
  }
}

function makeCheck(): PRCheckDetail {
  return {
    name: 'verify',
    status: 'completed',
    conclusion: 'success',
    url: 'https://example.test/check/verify'
  }
}

function renderPanel(): void {
  act(() => {
    root.render(<FolderWorkspacePrChecksPanel isVisible />)
  })
}

describe('FolderWorkspacePrChecksPanel', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    const repo = makeRepo()
    const worktree = makeWorktree()
    mockState.openedLinks = []
    mockState.store = {
      activeWorktreeId: folderWorkspaceKey('folder-1'),
      activeWorkspaceKey: folderWorkspaceKey('folder-1'),
      folderWorkspaces: [makeFolder()],
      workspaceLineageByChildKey: {
        [worktree.id]: {
          childWorkspaceKey: worktreeWorkspaceKey(worktree.id),
          childInstanceId: null,
          parentWorkspaceKey: folderWorkspaceKey('folder-1'),
          parentInstanceId: null,
          origin: 'cli',
          capture: { source: 'env-workspace', confidence: 'inferred' },
          createdAt: 1
        }
      },
      worktreeLineageById: {},
      worktreesByRepo: { 'repo-1': [worktree] },
      repos: [repo],
      settings: null,
      hostedReviewCache: {
        [getHostedReviewCacheKey(repo.path, 'feature', null, repo.id)]: {
          data: makeReview(),
          fetchedAt: 1
        }
      },
      prCache: {},
      checksCache: {
        [getGitHubRepoCacheKey(repo.path, repo.id, prChecksCacheSuffix(12, null, 'abc'), null)]: {
          data: [makeCheck()],
          fetchedAt: 1,
          headSha: 'abc'
        }
      },
      fetchHostedReviewForBranch: vi.fn(async () => makeReview()),
      fetchPRChecks: vi.fn(async () => [makeCheck()]),
      fetchPRCheckDetails: vi.fn(async () => null),
      setActiveWorktree: vi.fn(),
      setRightSidebarTab: vi.fn()
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('renders compact rows and expands inline checks on row click', () => {
    renderPanel()

    expect(container.textContent).toContain('Child worktree')
    expect(container.textContent).toContain('#12')
    expect(container.textContent).toContain('Checks passing')
    expect(container.querySelector('[data-testid="checks-list"]')).toBeNull()

    act(() => {
      container
        .querySelector<HTMLElement>('[aria-label="Show Child worktree PR check details"]')
        ?.click()
    })

    expect(container.querySelector('[data-testid="checks-list"]')).not.toBeNull()
    expect(
      container.querySelector('[aria-label="Hide Child worktree PR check details"]')
    ).not.toBeNull()
    expect(container.textContent).toContain('verify')
    expect(mockState.store.setActiveWorktree).not.toHaveBeenCalled()
    expect(mockState.store.setRightSidebarTab).not.toHaveBeenCalled()
  })

  it('opens external review links without activating the row', () => {
    renderPanel()

    act(() => {
      container.querySelector<HTMLElement>('[aria-label="Open PR externally"]')?.click()
    })

    expect(mockState.openedLinks).toEqual(['https://example.test/pr/12'])
    expect(mockState.store.setActiveWorktree).not.toHaveBeenCalled()
    expect(mockState.store.setRightSidebarTab).not.toHaveBeenCalled()
  })

  it('does not let external-link keyboard events activate the row', () => {
    renderPanel()
    const linkButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Open PR externally"]'
    )
    expect(linkButton).not.toBeNull()
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })

    act(() => {
      linkButton!.dispatchEvent(event)
    })

    expect(mockState.store.setActiveWorktree).not.toHaveBeenCalled()
    expect(mockState.store.setRightSidebarTab).not.toHaveBeenCalled()
  })

  it('uses manual force for one refresh generation only', async () => {
    renderPanel()

    await vi.waitFor(() => {
      expect(mockState.store.fetchHostedReviewForBranch).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Refresh PR checks"]')?.disabled
      ).toBe(false)
    })

    mockState.store.fetchHostedReviewForBranch.mockClear()
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh PR checks"]')?.click()
    })
    await vi.waitFor(() => {
      expect(mockState.store.fetchHostedReviewForBranch).toHaveBeenCalled()
    })
    expect(mockState.store.fetchHostedReviewForBranch.mock.calls[0]?.[2]).toMatchObject({
      force: true
    })

    await vi.waitFor(() => {
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Refresh PR checks"]')?.disabled
      ).toBe(false)
    })
    mockState.store.fetchHostedReviewForBranch.mockClear()
    const extraWorktree = makeWorktree()
    extraWorktree.id = 'repo-1::/second-child'
    extraWorktree.path = '/second-child'
    extraWorktree.displayName = 'Second child'
    mockState.store.worktreesByRepo = {
      'repo-1': [...mockState.store.worktreesByRepo['repo-1'], extraWorktree]
    }
    mockState.store.workspaceLineageByChildKey = {
      ...mockState.store.workspaceLineageByChildKey,
      [extraWorktree.id]: {
        childWorkspaceKey: worktreeWorkspaceKey(extraWorktree.id),
        childInstanceId: null,
        parentWorkspaceKey: folderWorkspaceKey('folder-1'),
        parentInstanceId: null,
        origin: 'cli',
        capture: { source: 'env-workspace', confidence: 'inferred' },
        createdAt: 2
      }
    }

    renderPanel()
    await vi.waitFor(() => {
      expect(mockState.store.fetchHostedReviewForBranch).toHaveBeenCalled()
    })
    expect(mockState.store.fetchHostedReviewForBranch.mock.calls[0]?.[2]).toMatchObject({
      force: false
    })
  })

  it('auto-refreshes without force and manual refresh forces provider refresh', async () => {
    renderPanel()

    await vi.waitFor(() => {
      expect(mockState.store.fetchHostedReviewForBranch).toHaveBeenCalled()
    })
    expect(mockState.store.fetchHostedReviewForBranch.mock.calls[0]?.[2]).toMatchObject({
      force: false
    })

    await vi.waitFor(() => {
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Refresh PR checks"]')?.disabled
      ).toBe(false)
    })
    mockState.store.fetchHostedReviewForBranch.mockClear()
    act(() => {
      container.querySelector<HTMLButtonElement>('[aria-label="Refresh PR checks"]')?.click()
    })

    await vi.waitFor(() => {
      expect(mockState.store.fetchHostedReviewForBranch).toHaveBeenCalled()
    })
    expect(mockState.store.fetchHostedReviewForBranch.mock.calls[0]?.[2]).toMatchObject({
      force: true
    })
  })
})
