import { linearIssueReadFixture } from '@/store/slices/linear/linear-slice-test-harness'
// @vitest-environment happy-dom

import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

import type { LinearIssue } from '../../../../shared/linear/issue-types'
import type { Repo } from '../../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'

import WorktreeJumpPalette from './WorktreeJumpPalette'
import { makeRecentTabState, makeRepo } from './worktree-jump-palette-test-fixtures'

const { lookupCmdJGitHubUrlWorkItem } = vi.hoisted(() => ({
  lookupCmdJGitHubUrlWorkItem: vi.fn()
}))

vi.mock('@/lib/cmd-j-github-url-lookup', () => ({
  lookupCmdJGitHubUrlWorkItem
}))

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactI18Next>()
  return {
    ...actual,
    useTranslation: () => ({
      t: (_key: string, fallback?: string) => fallback ?? _key
    })
  }
})

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    message: vi.fn()
  }
}))

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))

vi.mock('@/components/sidebar/workspace-card/surface/StatusIndicator', () => ({
  default: () => <span data-status-indicator="true" />
}))

vi.mock('@/components/repo/RepoBadgeLabel', () => ({
  RepoBadgeMark: () => <span data-repo-badge-mark="true" />
}))

vi.mock('@/components/cmd-j/palette-host-badge', () => ({
  getPaletteHostBadge: () => null
}))

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandDialog: ({
      children,
      open,
      commandProps
    }: {
      children: React.ReactNode
      open?: boolean
      commandProps?: { value?: string; onValueChange?: (next: string) => void }
    }) => {
      return open ? (
        <div data-command-dialog="true" data-command-value={commandProps?.value ?? ''}>
          {children}
        </div>
      ) : null
    },
    CommandInput: ({
      value,
      onValueChange
    }: {
      value?: string
      onValueChange?: (next: string) => void
    }) => {
      setCommandQuery = onValueChange ?? null
      return (
        <input
          data-command-input="true"
          value={value}
          onChange={(event) => onValueChange?.(event.currentTarget.value)}
        />
      )
    },
    CommandList: React.forwardRef(function CommandList(
      { children }: { children: React.ReactNode },
      ref: React.ForwardedRef<HTMLDivElement>
    ) {
      return (
        <div ref={ref} data-command-list="true">
          {children}
        </div>
      )
    }),
    CommandEmpty: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandItem: ({
      children,
      onSelect,
      value,
      ...props
    }: {
      children: React.ReactNode
      onSelect?: (value: string) => void
      value?: string
    } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect' | 'value'>) => (
      <button
        {...props}
        data-command-item={value ?? ''}
        onClick={() => onSelect?.(value ?? '')}
        type="button"
      >
        {children}
      </button>
    )
  }
})

const LINEAR_URL = 'https://linear.app/stably/issue/STA-4084/restore-osc-133-shell-integration'
const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement
let setCommandQuery: ((next: string) => void) | null = null

function makeLinearIssue(patch: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'issue-sta-4084',
    workspaceId: 'linear-workspace-1',
    workspaceName: 'Stably',
    identifier: 'STA-4084',
    title: 'Restore OSC 133 shell integration',
    branchName: 'sta-4084-restore-osc-133-shell-integration',
    url: LINEAR_URL,
    state: { name: 'Todo', type: 'unstarted', color: '#999999' },
    team: { id: 'team-sta', name: 'Stably', key: 'STA' },
    labels: [],
    labelIds: [],
    estimate: null,
    priority: 2,
    updatedAt: '2026-08-12T12:00:00.000Z',
    ...patch
  }
}

function deferredValue<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  return {
    promise: new Promise<T>((next) => {
      resolve = next
    }),
    resolve
  }
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function renderPalette(overrides: Partial<AppState>): Promise<void> {
  useAppStore.setState({
    activeModal: 'worktree-palette',
    activeWorktreeId: null,
    repos: [makeRepo()],
    tabsByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    unifiedTabsByWorktree: {},
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    alwaysShowDefaultBranchWorkspace: true,
    lastVisitedAtByWorktreeId: {},
    linearStatus: {
      connected: true,
      viewer: null,
      workspaces: [
        {
          id: 'linear-workspace-1',
          displayName: 'Linear User',
          email: null,
          organizationId: 'linear-organization-1',
          organizationName: 'Stably',
          organizationUrlKey: 'stably'
        }
      ],
      selectedWorkspaceId: 'all'
    },
    ...makeRecentTabState(),
    ...overrides
  } as Partial<AppState>)

  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}

function getCommandValue(): string {
  return (
    testContainer.querySelector<HTMLElement>('[data-command-dialog]')?.dataset.commandValue ?? ''
  )
}

describe('WorktreeJumpPalette Linear URL intent', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    lookupCmdJGitHubUrlWorkItem.mockReset()
    lookupCmdJGitHubUrlWorkItem.mockResolvedValue(null)
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => {
      testRoot.unmount()
    })
    vi.useRealTimers()
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('opens the composer with the resolved issue and generated workspace name', async () => {
    await renderPalette({
      fetchLinearIssue: vi.fn(() =>
        linearIssueReadFixture<LinearIssue | null>(async () => makeLinearIssue())
      ),
      prefetchWorktreeCreateBase: vi.fn(async () => {})
    })
    await act(async () => setCommandQuery?.(LINEAR_URL))
    await flushEffects()

    await act(async () => {
      testContainer.querySelector<HTMLElement>('[data-command-item="__create_worktree__"]')?.click()
      await Promise.resolve()
    })
    await flushEffects()

    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(useAppStore.getState().modalData).toMatchObject({
      prefilledName: 'sta-4084-restore-osc-133-shell-integration',
      initialRepoId: 'repo-1',
      telemetrySource: 'command_palette',
      linkedWorkItem: {
        provider: 'linear',
        type: 'issue',
        linearIdentifier: 'STA-4084',
        linearWorkspaceId: 'linear-workspace-1',
        title: 'Restore OSC 133 shell integration'
      },
      taskSourceContext: {
        provider: 'linear',
        projectId: 'repo:repo-1',
        projectHostSetupId: 'repo-1',
        repoId: 'repo-1',
        hostId: 'local',
        providerIdentity: {
          provider: 'linear',
          workspaceId: 'linear-workspace-1',
          workspaceName: 'Stably',
          teamId: 'team-sta',
          teamKey: 'STA'
        }
      }
    })
  })

  it('keeps runtime folder projects as the Linear lookup and composer owner', async () => {
    const folderRepo: Repo = {
      ...makeRepo(),
      id: 'folder-repo',
      kind: 'folder' as const,
      executionHostId: 'runtime:folder-env'
    }
    const fetchLinearIssue = vi.fn(() =>
      linearIssueReadFixture<LinearIssue | null>(async () => makeLinearIssue())
    )
    const prefetchWorktreeCreateBase = vi.fn(async () => {})
    await renderPalette({
      activeRepoId: folderRepo.id,
      repos: [folderRepo],
      fetchLinearIssue,
      prefetchWorktreeCreateBase
    })
    await act(async () => setCommandQuery?.(LINEAR_URL))
    await flushEffects()

    expect(fetchLinearIssue).toHaveBeenCalledWith(
      'STA-4084',
      'linear-workspace-1',
      expect.objectContaining({
        sourceContext: expect.objectContaining({
          provider: 'linear',
          projectId: 'repo:folder-repo',
          projectHostSetupId: 'folder-repo',
          repoId: 'folder-repo',
          hostId: 'runtime:folder-env'
        })
      })
    )

    await act(async () => {
      testContainer.querySelector<HTMLElement>('[data-command-item="__create_worktree__"]')?.click()
      await Promise.resolve()
    })
    await flushEffects()

    expect(useAppStore.getState().modalData).toMatchObject({
      initialRepoId: 'folder-repo',
      taskSourceContext: {
        provider: 'linear',
        projectId: 'repo:folder-repo',
        projectHostSetupId: 'folder-repo',
        repoId: 'folder-repo',
        hostId: 'runtime:folder-env'
      }
    })
    const projection = projectHostSetupProjectionFromRepos([folderRepo])
    expect(
      resolveWorkspaceCreationTarget({
        eligibleRepos: [folderRepo],
        projects: projection.projects,
        projectHostSetups: projection.setups,
        initialRepoId: 'folder-repo',
        projectId: 'repo:folder-repo',
        hostId: 'runtime:folder-env',
        projectHostSetupId: 'folder-repo'
      })
    ).toMatchObject({ status: 'ready', target: { repoId: 'folder-repo' } })
    expect(prefetchWorktreeCreateBase).not.toHaveBeenCalled()
  })

  it('does not open the composer after the palette closes during lookup', async () => {
    const issueLookup = deferredValue<LinearIssue | null>()
    await renderPalette({
      fetchLinearIssue: vi.fn(() =>
        linearIssueReadFixture<LinearIssue | null>(() => issueLookup.promise)
      )
    })
    await act(async () => setCommandQuery?.(LINEAR_URL))
    await flushEffects()

    await act(async () => {
      testContainer.querySelector<HTMLElement>('[data-command-item="__create_worktree__"]')?.click()
      useAppStore.getState().closeModal()
    })
    await act(async () => {
      issueLookup.resolve(makeLinearIssue())
      await issueLookup.promise
    })
    await flushEffects()

    expect(useAppStore.getState().activeModal).toBe('none')
  })

  it('awaits the live URL after replacing an already resolved URL', async () => {
    const secondLookup = deferredValue<LinearIssue | null>()
    await renderPalette({
      fetchLinearIssue: vi.fn((identifier: string) =>
        linearIssueReadFixture<LinearIssue | null>(() =>
          identifier === 'STA-4084' ? Promise.resolve(makeLinearIssue()) : secondLookup.promise
        )
      )
    })
    await act(async () => setCommandQuery?.(LINEAR_URL))
    await flushEffects()
    await act(async () =>
      setCommandQuery?.('https://linear.app/stably/issue/STA-4099/current-second-issue')
    )
    await flushEffects()

    await act(async () => {
      testContainer.querySelector<HTMLElement>('[data-command-item="__create_worktree__"]')?.click()
    })
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')

    await act(async () => {
      secondLookup.resolve(
        makeLinearIssue({
          id: 'issue-sta-4099',
          identifier: 'STA-4099',
          title: 'Current second issue',
          url: 'https://linear.app/stably/issue/STA-4099/current-second-issue'
        })
      )
      await secondLookup.promise
    })
    await flushEffects()

    expect(useAppStore.getState().modalData).toMatchObject({
      linkedWorkItem: { linearIdentifier: 'STA-4099', title: 'Current second issue' }
    })
  })

  it('does not let a stale lookup replace a newer URL preview', async () => {
    const firstLookup = deferredValue<LinearIssue | null>()
    const secondLookup = deferredValue<LinearIssue | null>()
    await renderPalette({
      fetchLinearIssue: vi.fn((identifier: string) =>
        linearIssueReadFixture<LinearIssue | null>(() =>
          identifier === 'STA-4084' ? firstLookup.promise : secondLookup.promise
        )
      )
    })

    vi.useFakeTimers()
    await act(async () => setCommandQuery?.('https://linear.app/stably/issue/STA-4084/first'))
    await flushEffects()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(testContainer.textContent).toContain('Loading Linear issue…')

    await act(async () => {
      flushSync(() => setCommandQuery?.('https://linear.app/stably/issue/STA-4099/second'))
      const currentPendingRow = testContainer.querySelector<HTMLElement>(
        '[data-cmd-j-linear-issue-preview="true"]'
      )
      expect(currentPendingRow?.getAttribute('aria-label')).toBe(
        'Create worktree from Linear issue STA-4099'
      )
      expect(currentPendingRow?.textContent).toContain('Create worktree from Linear issue')
      expect(currentPendingRow?.textContent).not.toContain('Loading Linear issue…')
    })
    await flushEffects()

    await act(async () => {
      firstLookup.resolve(makeLinearIssue({ title: 'Stale first issue' }))
      await firstLookup.promise
    })
    await flushEffects()

    expect(testContainer.textContent).toContain('STA-4099')
    expect(testContainer.textContent).not.toContain('Stale first issue')

    await act(async () => {
      secondLookup.resolve(
        makeLinearIssue({
          id: 'issue-sta-4099',
          identifier: 'STA-4099',
          title: 'Current second issue',
          url: 'https://linear.app/stably/issue/STA-4099/current-second-issue'
        })
      )
      await secondLookup.promise
    })
    await flushEffects()

    expect(testContainer.textContent).toContain('Current second issue')
    expect(testContainer.textContent).not.toContain('Stale first issue')
    expect(getCommandValue()).toBe('__create_worktree__')
  })
})
