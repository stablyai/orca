// @vitest-environment happy-dom

import { act } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import type { LinearIssue } from '../../../shared/linear/issue-types'
import type { Repo } from '../../../shared/repo-types'
import { projectHostSetupProjectionFromRepos } from '../../../shared/project-host-setup-projection'
import { resolveWorkspaceCreationTarget } from '@/lib/project-host-workspace-target'
import { WORKTREE_PALETTE_QUERY_MAX_BYTES } from '@/lib/worktree-palette-query-bounds'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { makeRecentTabState, makeRepo, makeWorktree } from './worktree-jump-palette-test-fixtures'

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

vi.mock('@/components/sidebar/StatusIndicator', () => ({
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
      commandProps,
      onOpenChange
    }: {
      children: React.ReactNode
      open?: boolean
      commandProps?: { value?: string; onValueChange?: (next: string) => void }
      onOpenChange?: (open: boolean) => void
    }) => {
      requestCommandDialogClose = () => onOpenChange?.(false)
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
let requestCommandDialogClose: (() => void) | null = null

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

function getRenderedRowIds(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item]')].map(
    (node) => node.dataset.commandItem ?? ''
  )
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
    requestCommandDialogClose = null
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

  it('delays loading feedback before replacing the pending row with an issue preview', async () => {
    const issueLookup = deferredValue<LinearIssue | null>()
    const fetchLinearIssue = vi.fn(() => issueLookup.promise)
    await renderPalette({
      fetchLinearIssue,
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
      }
    })

    vi.useFakeTimers()
    await act(async () => setCommandQuery?.(LINEAR_URL))
    await flushEffects()

    const pendingRow = testContainer.querySelector<HTMLElement>(
      '[data-cmd-j-linear-issue-preview="true"]'
    )
    expect(getRenderedRowIds().find(Boolean)).toBe('__create_worktree__')
    expect(getCommandValue()).toBe('__create_worktree__')
    expect(pendingRow?.dataset.cmdJLinearIssueState).toBe('loading')
    expect(pendingRow?.getAttribute('aria-busy')).toBe('true')
    expect(pendingRow?.getAttribute('aria-label')).toBe(
      'Create worktree from Linear issue STA-4084'
    )
    expect(pendingRow?.textContent).toContain('Create worktree from Linear issue')
    expect(pendingRow?.textContent).not.toContain('Loading Linear issue…')
    expect(fetchLinearIssue).toHaveBeenCalledWith(
      'STA-4084',
      'linear-workspace-1',
      expect.objectContaining({
        sourceContext: expect.objectContaining({
          provider: 'linear',
          projectId: 'repo:repo-1',
          projectHostSetupId: 'repo-1',
          repoId: 'repo-1',
          hostId: 'local'
        })
      })
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(199)
    })
    expect(pendingRow?.textContent).not.toContain('Loading Linear issue…')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    expect(pendingRow?.getAttribute('aria-label')).toBe('Loading Linear issue STA-4084')
    expect(pendingRow?.textContent).toContain('Loading Linear issue…')

    await act(async () => {
      issueLookup.resolve(makeLinearIssue())
      await issueLookup.promise
    })
    await flushEffects()

    const resolvedRow = testContainer.querySelector<HTMLElement>(
      '[data-cmd-j-linear-issue-preview="true"]'
    )
    expect(resolvedRow?.dataset.cmdJLinearIssueState).toBe('resolved')
    expect(resolvedRow?.textContent).toContain('STA-4084')
    expect(resolvedRow?.textContent).toContain('Restore OSC 133 shell integration')
    expect(getRenderedRowIds().find(Boolean)).toBe('__create_worktree__')
    expect(getCommandValue()).toBe('__create_worktree__')
  })

  it('rejects oversized Linear URLs before lookup or create-row rendering', async () => {
    const fetchLinearIssue = vi.fn(async () => makeLinearIssue())
    await renderPalette({ fetchLinearIssue })

    await act(async () =>
      setCommandQuery?.(`${LINEAR_URL}/${'a'.repeat(WORKTREE_PALETTE_QUERY_MAX_BYTES)}`)
    )
    await flushEffects()

    expect(fetchLinearIssue).not.toHaveBeenCalled()
    expect(getRenderedRowIds()).not.toContain('__create_worktree__')
    expect(testContainer.querySelector('[data-cmd-j-linear-issue-preview="true"]')).toBeNull()
  })

  it('opens the composer with the resolved issue and generated workspace name', async () => {
    await renderPalette({
      fetchLinearIssue: vi.fn(async () => makeLinearIssue()),
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
    const fetchLinearIssue = vi.fn(async () => makeLinearIssue())
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

  it('maps a runtime-owned active repo to its eligible project sibling', async () => {
    const unrelatedRepo = { ...makeRepo(), id: 'unrelated-repo' }
    const localSibling = {
      ...makeRepo(),
      id: 'local-sibling',
      upstream: { owner: 'stablyai', repo: 'orca' }
    }
    const runtimeOwnedRepo = {
      ...makeRepo(),
      id: 'runtime-owned',
      connectionId: 'runtime-ssh-workspace-1',
      upstream: { owner: 'stablyai', repo: 'orca' }
    }
    const fetchLinearIssue = vi.fn(async () => makeLinearIssue())
    await renderPalette({
      activeRepoId: runtimeOwnedRepo.id,
      repos: [unrelatedRepo, localSibling, runtimeOwnedRepo],
      fetchLinearIssue
    })
    await act(async () => setCommandQuery?.(LINEAR_URL))
    await flushEffects()

    expect(fetchLinearIssue).toHaveBeenCalledWith(
      'STA-4084',
      'linear-workspace-1',
      expect.objectContaining({
        sourceContext: expect.objectContaining({
          projectId: 'github:stablyai/orca',
          repoId: 'local-sibling'
        })
      })
    )
  })

  it('does not open the composer after the palette closes during lookup', async () => {
    const issueLookup = deferredValue<LinearIssue | null>()
    await renderPalette({ fetchLinearIssue: vi.fn(() => issueLookup.promise) })
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

  it('restores focus when a loading selection is abandoned', async () => {
    const focusTarget = document.createElement('button')
    document.body.appendChild(focusTarget)
    focusTarget.focus()
    const issueLookup = deferredValue<LinearIssue | null>()
    await renderPalette({
      activeWorktreeId: 'wt-alpha',
      fetchLinearIssue: vi.fn(() => issueLookup.promise)
    })
    await act(async () => setCommandQuery?.(LINEAR_URL))
    await flushEffects()
    await act(async () => {
      testContainer.querySelector<HTMLElement>('[data-command-item="__create_worktree__"]')?.click()
    })
    await act(async () => setCommandQuery?.('ordinary name'))
    testContainer.querySelector<HTMLElement>('[data-command-input="true"]')?.focus()

    await act(async () => requestCommandDialogClose?.())
    await act(async () => {
      issueLookup.resolve(makeLinearIssue())
      await issueLookup.promise
      await new Promise((resolve) => window.setTimeout(resolve, 50))
    })

    expect(document.activeElement).toBe(focusTarget)
    expect(useAppStore.getState().activeModal).toBe('none')
  })

  it('awaits the live URL after replacing an already resolved URL', async () => {
    const secondLookup = deferredValue<LinearIssue | null>()
    await renderPalette({
      fetchLinearIssue: vi.fn((identifier: string) =>
        identifier === 'STA-4084' ? Promise.resolve(makeLinearIssue()) : secondLookup.promise
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
        identifier === 'STA-4084' ? firstLookup.promise : secondLookup.promise
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

  it('selects an existing Linear-linked worktree and keeps create underneath', async () => {
    const linked = makeWorktree('wt-linked', 'Linked Linear workspace', {
      linkedLinearIssue: 'STA-4084',
      linkedLinearIssueOrganizationUrlKey: 'stably'
    })
    const other = makeWorktree('wt-other', 'Unrelated workspace')
    await renderPalette({
      fetchLinearIssue: vi.fn(async () => makeLinearIssue()),
      worktreesByRepo: { 'repo-1': [other, linked] }
    })

    await act(async () => setCommandQuery?.(LINEAR_URL))
    await flushEffects()

    expect(getRenderedRowIds().filter(Boolean)).toEqual([
      'worktree:wt-linked',
      '__create_worktree__'
    ])
    expect(getCommandValue()).toBe('worktree:wt-linked')
    expect(testContainer.querySelector('[data-cmd-j-linear-issue-preview="true"]')).not.toBeNull()
  })

  it('resolves a pasted GitHub issue URL and opens create with the linked issue', async () => {
    const githubIssueUrl = 'https://github.com/stablyai/orca/issues/14198'
    const githubIssue = {
      id: 'issue-14198',
      type: 'issue',
      number: 14198,
      title: 'Agent terminals disappearing randomly',
      state: 'open',
      url: githubIssueUrl,
      labels: [],
      updatedAt: '2026-08-12T12:00:00.000Z',
      author: 'nwparker',
      repoId: 'repo-1'
    } satisfies GitHubWorkItem
    lookupCmdJGitHubUrlWorkItem.mockResolvedValue(githubIssue)
    await renderPalette({
      prefetchWorktreeCreateBase: vi.fn(async () => {})
    })

    await act(async () => setCommandQuery?.(githubIssueUrl))
    await flushEffects()

    const preview = testContainer.querySelector<HTMLElement>('[data-cmd-j-task-url-preview="true"]')
    expect(getRenderedRowIds().find(Boolean)).toBe('__create_worktree__')
    expect(getCommandValue()).toBe('__create_worktree__')
    expect(preview?.dataset.cmdJTaskUrlProvider).toBe('github')
    expect(preview?.dataset.cmdJTaskUrlState).toBe('resolved')
    expect(preview?.getAttribute('aria-label')).toBe(
      'Create worktree from GitHub issue stablyai/orca#14198: Agent terminals disappearing randomly'
    )
    expect(preview?.textContent).toContain('#14198')
    expect(preview?.textContent).toContain('Agent terminals disappearing randomly')
    expect(lookupCmdJGitHubUrlWorkItem).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({ type: 'issue', number: 14198 }),
        repo: expect.objectContaining({ id: 'repo-1' })
      })
    )

    await act(async () => {
      preview?.click()
      await Promise.resolve()
    })
    await flushEffects()

    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
    expect(useAppStore.getState().modalData).toMatchObject({
      prefilledName: 'agent-terminals-disappearing-randomly',
      initialRepoId: 'repo-1',
      telemetrySource: 'command_palette',
      linkedWorkItem: {
        provider: 'github',
        type: 'issue',
        number: 14198,
        title: 'Agent terminals disappearing randomly',
        url: githubIssueUrl,
        repoId: 'repo-1'
      },
      initialGitHubWorkItem: githubIssue
    })
  })

  it('previews a pasted GitHub pull URL', async () => {
    await renderPalette({})
    await act(async () => setCommandQuery?.('https://github.com/stablyai/orca/pull/12789'))
    await flushEffects()

    const preview = testContainer.querySelector<HTMLElement>('[data-cmd-j-task-url-preview="true"]')
    expect(preview?.dataset.cmdJTaskUrlProvider).toBe('github')
    expect(preview?.getAttribute('aria-label')).toBe(
      'Create worktree from GitHub pull request stablyai/orca#12789'
    )
    expect(preview?.textContent).toContain('#12789')
  })

  it('selects an existing GitHub-linked worktree and keeps create underneath', async () => {
    const linked = makeWorktree('wt-linked', 'Linked GitHub workspace', { linkedIssue: 14198 })
    const other = makeWorktree('wt-other', 'Unrelated workspace', { linkedIssue: 7 })
    await renderPalette({
      repos: [{ ...makeRepo(), displayName: 'stablyai/orca' }],
      worktreesByRepo: { 'repo-1': [other, linked] }
    })

    await act(async () => setCommandQuery?.('https://github.com/stablyai/orca/issues/14198'))
    await flushEffects()

    expect(getRenderedRowIds().filter(Boolean)).toEqual([
      'worktree:wt-linked',
      '__create_worktree__'
    ])
    expect(getCommandValue()).toBe('worktree:wt-linked')
    expect(
      testContainer.querySelector<HTMLElement>('[data-cmd-j-task-url-preview="true"]')?.dataset
        .cmdJTaskUrlProvider
    ).toBe('github')
  })
})
