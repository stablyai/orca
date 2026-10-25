// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import type { activateAndRevealWorkspace as ActivateWorkspace } from '@/lib/worktree-activation'
import type { WorkspaceTabPaletteActivationResult } from '@/lib/workspace-tab-palette-activation'
import { toast } from 'sonner'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import {
  makeFolderWorkspace,
  makeGroup,
  makeRepo,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree
} from './worktree-jump-palette-test-fixtures'

const { activateAndRevealWorkspace } = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn<typeof ActivateWorkspace>(() => ({ primaryTabId: null }))
}))

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorkspace }))

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

// Stub activation at its boundary; the palette contract is which result it hands over.
const { activateWorkspaceTabPaletteResult } = vi.hoisted(() => ({
  activateWorkspaceTabPaletteResult: vi.fn(
    (_result: unknown): WorkspaceTabPaletteActivationResult => ({ status: 'activated' })
  )
}))
vi.mock('@/lib/workspace-tab-palette-activation', () => ({
  activateWorkspaceTabPaletteResult: (result: unknown) => activateWorkspaceTabPaletteResult(result)
}))

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    // Pass controlled cmdk value through so Enter-target assertions reflect actual selection.
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
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandInput: React.forwardRef(function CommandInput(
      {
        value,
        onValueChange,
        placeholder,
        onClick,
        onSelect,
        onKeyDown
      }: {
        value?: string
        onValueChange?: (next: string) => void
        placeholder?: string
        onClick?: React.MouseEventHandler<HTMLInputElement>
        onSelect?: React.ReactEventHandler<HTMLInputElement>
        onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
      },
      ref: React.ForwardedRef<HTMLInputElement>
    ) {
      setCommandQuery = onValueChange ?? null
      return (
        <input
          ref={ref}
          data-command-input="true"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onValueChange?.(event.currentTarget.value)}
          onClick={onClick}
          onSelect={onSelect}
          onKeyDown={onKeyDown}
        />
      )
    }),
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
    CommandEmpty: ({ children }: { children: React.ReactNode }) => (
      <div data-command-empty="true">{children}</div>
    ),
    CommandItem: ({
      children,
      onSelect,
      value
    }: {
      children: React.ReactNode
      onSelect?: (value: string) => void
      value?: string
    }) => (
      <button data-command-item={value ?? ''} onClick={() => onSelect?.(value ?? '')} type="button">
        {children}
      </button>
    )
  }
})

const initialAppState = useAppStore.getInitialState()
let testRoot: Root
let testContainer: HTMLDivElement
let setCommandQuery: ((next: string) => void) | null = null

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
    // Why explicit: the sweep exemption is what these cases probe, so it must
    // not ride on whatever the store default happens to be.
    alwaysShowDefaultBranchWorkspace: true,
    lastVisitedAtByWorktreeId: {},
    ...overrides
  } as Partial<AppState>)

  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}

function getWorktreeRows(): string[] {
  return [
    ...testContainer.querySelectorAll<HTMLElement>(
      `[data-command-item^="${encodePaletteIdentity(['worktree'])}"]`
    )
  ].map((node) => node.textContent ?? '')
}

describe('WorktreeJumpPalette', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    activateAndRevealWorkspace.mockReset().mockReturnValue({ primaryTabId: null })
    activateWorkspaceTabPaletteResult.mockReset().mockReturnValue({ status: 'activated' })
    vi.mocked(toast.error).mockClear()
    useAppStore.setState(initialAppState, true)
    testContainer = document.createElement('div')
    document.body.appendChild(testContainer)
    testRoot = createRoot(testContainer)
  })

  afterEach(async () => {
    await act(async () => {
      testRoot.unmount()
    })
    document.body.replaceChildren()
    useAppStore.setState(initialAppState, true)
  })

  it('lists actual folder workspaces with no repositories or active terminals', async () => {
    await renderPalette({
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [makeFolderWorkspace()],
      showSleepingWorkspaces: false,
      hideDefaultBranchWorkspace: true,
      hideDetachedHeadWorkspaces: true
    })

    expect(getWorktreeRows()).toHaveLength(1)
    expect(getWorktreeRows()[0]).toContain('Design workspace')
    expect(testContainer.textContent).not.toContain('Loading')
  })

  it('orders folders and git worktrees together by visit recency', async () => {
    await renderPalette({
      worktreesByRepo: { 'repo-1': [makeWorktree('git', 'Git workspace')] },
      folderWorkspaces: [makeFolderWorkspace()],
      showSleepingWorkspaces: true,
      lastVisitedAtByWorktreeId: { 'local|folder:folder-1': 20, git: 10 }
    })

    expect(getWorktreeRows()).toHaveLength(2)
    expect(getWorktreeRows()[0]).toContain('Design workspace')
    expect(getWorktreeRows()[1]).toContain('Git workspace')
  })

  it('searches folder names and comments but never returns archived folders', async () => {
    await renderPalette({
      worktreesByRepo: {},
      folderWorkspaces: [
        makeFolderWorkspace({ comment: 'Prototype checkout flow' }),
        makeFolderWorkspace({ id: 'archived', name: 'Archived design', isArchived: true })
      ]
    })

    await act(async () => setCommandQuery?.('design'))
    await flushEffects()
    expect(getWorktreeRows()).toHaveLength(1)
    expect(getWorktreeRows()[0]).toContain('Design workspace')
    await act(async () => setCommandQuery?.('checkout'))
    await flushEffects()
    expect(getWorktreeRows()[0]).toContain('Design workspace')
    expect(getWorktreeRows()[0]).toContain('Prototype checkout flow')
  })

  it('excludes only the current host when folder ids collide', async () => {
    await renderPalette({
      worktreesByRepo: {},
      folderWorkspaces: [
        makeFolderWorkspace({ name: 'Local design', executionHostId: 'local' }),
        makeFolderWorkspace({ name: 'Remote design', executionHostId: 'runtime:builder' })
      ],
      activeWorktreeId: 'folder:folder-1',
      activeWorkspaceExecutionHostId: 'local'
    })
    expect(getWorktreeRows()).toHaveLength(1)
    expect(getWorktreeRows()[0]).toContain('Remote design')

    await act(async () => setCommandQuery?.('design'))
    await flushEffects()
    expect(getWorktreeRows()).toHaveLength(2)
    expect(getWorktreeRows().find((row) => row.includes('Local design'))).toContain('Current')
    const remote = testContainer.querySelector<HTMLButtonElement>(
      `[data-command-item="${encodePaletteIdentity(['worktree', 'runtime:builder|folder:folder-1'])}"]`
    )
    await act(async () => fireEvent.click(remote!))
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('folder:folder-1', {
      navigationIntent: 'user-open',
      executionHostId: 'runtime:builder'
    })
  })

  it('filters remote folders by host and searches their visible host badge without a repo', async () => {
    await renderPalette({
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [
        makeFolderWorkspace(),
        makeFolderWorkspace({ id: 'remote', name: 'Remote design', executionHostId: 'ssh:box' })
      ],
      sshTargetLabels: new Map([['box', 'Builder']]),
      visibleWorkspaceHostIds: ['ssh:box']
    })

    expect(getWorktreeRows()).toHaveLength(1)
    expect(getWorktreeRows()[0]).toContain('Remote design')
    expect(getWorktreeRows()[0]).toContain('Builder')
    await act(async () => setCommandQuery?.('Builder'))
    await flushEffects()
    expect(getWorktreeRows()).toHaveLength(1)
    expect(getWorktreeRows()[0]).toContain('Remote design')
    expect(getWorktreeRows()[0]).toContain('Builder')
  })

  it('excludes folders when a repository filter is selected', async () => {
    await renderPalette({
      worktreesByRepo: { 'repo-1': [makeWorktree('git', 'Git workspace')] },
      folderWorkspaces: [makeFolderWorkspace()],
      showSleepingWorkspaces: true,
      filterRepoIds: ['repo-1']
    })

    expect(getWorktreeRows()).toHaveLength(1)
    expect(getWorktreeRows()[0]).toContain('Git workspace')
    await act(async () => setCommandQuery?.('Design'))
    await flushEffects()
    expect(getWorktreeRows()).toEqual([])
  })

  it('includes hosts owned only by folders in the host registry', async () => {
    await renderPalette({
      repos: [],
      worktreesByRepo: {},
      folderWorkspaces: [makeFolderWorkspace({ executionHostId: 'runtime:builder' })],
      visibleWorkspaceHostIds: ['runtime:builder']
    })

    expect(getWorktreeRows()).toHaveLength(1)
    expect(getWorktreeRows()[0]).toContain('builder')
  })

  it('refreshes the folder catalog while the palette is open', async () => {
    await renderPalette({ repos: [], worktreesByRepo: {}, folderWorkspaces: [] })
    await act(async () => {
      useAppStore.setState({ folderWorkspaces: [makeFolderWorkspace()] })
    })
    expect(getWorktreeRows()).toHaveLength(1)
    expect(getWorktreeRows()[0]).toContain('Design workspace')
    await act(async () => useAppStore.setState({ folderWorkspaces: [] }))
    expect(getWorktreeRows()).toEqual([])
  })

  it('keeps the palette open when folder activation is blocked', async () => {
    await renderPalette({ worktreesByRepo: {}, folderWorkspaces: [makeFolderWorkspace()] })
    activateAndRevealWorkspace.mockReturnValue(false)
    const row = testContainer.querySelector<HTMLButtonElement>(
      `[data-command-item="${encodePaletteIdentity(['worktree', 'local|folder:folder-1'])}"]`
    )

    await act(async () => fireEvent.click(row!))
    expect(testContainer.querySelector('[data-command-dialog]')).not.toBeNull()
    expect(useAppStore.getState().activeModal).toBe('worktree-palette')
  })

  it.each([true, false])(
    'routes an attached folder from a GitHub number (activation %s)',
    async (opens) => {
      await renderPalette({
        worktreesByRepo: {},
        folderWorkspaces: [
          makeFolderWorkspace({
            linkedItems: [
              {
                provider: 'github',
                type: 'issue',
                number: 42,
                title: 'Checkout',
                repoId: 'repo-1',
                url: 'https://github.com/acme/product/issues/42'
              }
            ]
          })
        ]
      })
      activateAndRevealWorkspace.mockReturnValue(opens ? { primaryTabId: null } : false)
      await act(async () => setCommandQuery?.('#42'))
      await flushEffects()
      const create = testContainer.querySelector<HTMLButtonElement>(
        '[data-command-item="__create_worktree__"]'
      )
      await act(async () => fireEvent.click(create!))

      expect(activateAndRevealWorkspace).toHaveBeenCalledWith('folder:folder-1', {
        executionHostId: 'local'
      })
      expect(useAppStore.getState().activeModal).toBe(opens ? 'none' : 'worktree-palette')
    }
  )

  it('includes open terminal tabs from folder workspaces in search', async () => {
    const workspaceId = 'folder:folder-1'
    await renderPalette({
      worktreesByRepo: {},
      folderWorkspaces: [makeFolderWorkspace()],
      tabsByWorktree: { [workspaceId]: [makeTerminalTab('term-1', workspaceId, 'Research chat')] },
      unifiedTabsByWorktree: {
        [workspaceId]: [makeUnifiedTab('tab-1', workspaceId, 'term-1', 'Research chat')]
      },
      groupsByWorktree: { [workspaceId]: [makeGroup(workspaceId, ['tab-1'])] },
      activeGroupIdByWorktree: { [workspaceId]: `group-${workspaceId}` }
    })

    await act(async () => setCommandQuery?.('Research'))
    await flushEffects()
    expect(testContainer.textContent).toContain('Research chat')
    expect(testContainer.textContent).toContain('Design workspace')
  })

  it('keeps a blocked folder tab jump open without a second error', async () => {
    const workspaceId = 'folder:folder-1'
    await renderPalette({
      worktreesByRepo: {},
      folderWorkspaces: [makeFolderWorkspace()],
      tabsByWorktree: { [workspaceId]: [makeTerminalTab('term-1', workspaceId, 'Research chat')] },
      unifiedTabsByWorktree: {
        [workspaceId]: [makeUnifiedTab('tab-1', workspaceId, 'term-1', 'Research chat')]
      },
      groupsByWorktree: { [workspaceId]: [makeGroup(workspaceId, ['tab-1'])] }
    })
    activateWorkspaceTabPaletteResult.mockReturnValue({ status: 'blocked' })
    await act(async () => setCommandQuery?.('Research'))
    await flushEffects()
    const row = testContainer.querySelector<HTMLButtonElement>(
      `[data-command-item^="${encodePaletteIdentity(['workspace-tab'])}"]`
    )
    expect(row).not.toBeNull()
    await act(async () => fireEvent.click(row!))

    expect(activateWorkspaceTabPaletteResult).toHaveBeenCalled()
    expect(testContainer.querySelector('[data-command-dialog]')).not.toBeNull()
    expect(toast.error).not.toHaveBeenCalled()
  })

  it('keeps every inactive main workspace visible when sleeping workspaces are hidden', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })
    const folderMain = makeWorktree('folder-main', 'Folder workspace', {
      isMainWorktree: true,
      branch: ''
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature, folderMain] },
      showSleepingWorkspaces: false
    })

    expect(testContainer.textContent).toContain('Default branch workspace')
    expect(testContainer.textContent).not.toContain('Feature workspace')
    // Main-checkout exemption includes branchless folder workspaces as project entry points.
    expect(testContainer.textContent).toContain('Folder workspace')
  })

  it('keeps the explicit default-branch filter authoritative', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch] },
      showSleepingWorkspaces: false,
      hideDefaultBranchWorkspace: true
    })

    expect(testContainer.textContent).not.toContain('Default branch workspace')
  })

  it('keeps an active non-default workspace visible when sleeping workspaces are hidden', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })
    const folderMain = makeWorktree('folder-main', 'Folder workspace', {
      isMainWorktree: true,
      branch: ''
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature, folderMain] },
      showSleepingWorkspaces: false,
      browserTabsByWorktree: {
        feature: [
          {
            id: 'browser-tab-1',
            worktreeId: 'feature',
            url: 'https://example.com',
            title: 'example.com',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      }
    })

    expect(testContainer.textContent).toContain('Feature workspace')
    expect(testContainer.textContent).toContain('Default branch workspace')
    expect(testContainer.textContent).toContain('Folder workspace')
  })

  it('sweeps the sleeping main workspace once the exemption is opted out', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature] },
      showSleepingWorkspaces: false,
      alwaysShowDefaultBranchWorkspace: false
    })

    expect(getWorktreeRows()).toEqual([])
    expect(testContainer.textContent).not.toContain('Default branch workspace')
    expect(testContainer.textContent).not.toContain('Feature workspace')
  })

  it('keeps the show-sleeping baseline and empty-query ordering intact', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })
    const folderMain = makeWorktree('folder-main', 'Folder workspace', {
      isMainWorktree: true,
      branch: ''
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature, folderMain] },
      showSleepingWorkspaces: true,
      lastVisitedAtByWorktreeId: {
        feature: 300,
        'default-branch': 200,
        'folder-main': 100
      }
    })

    expect(getWorktreeRows()).toEqual([
      expect.stringContaining('Feature workspace'),
      expect.stringContaining('Default branch workspace'),
      expect.stringContaining('Folder workspace')
    ])
  })

  it('keeps typed-query results on the full non-archived scope', async () => {
    const defaultBranch = makeWorktree('default-branch', 'Default branch workspace', {
      isMainWorktree: true,
      branch: 'refs/heads/main'
    })
    const feature = makeWorktree('feature', 'Feature workspace', {
      branch: 'refs/heads/feature'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [defaultBranch, feature] },
      showSleepingWorkspaces: false
    })

    expect(testContainer.textContent).not.toContain('Feature workspace')

    expect(setCommandQuery).not.toBeNull()

    await act(async () => {
      setCommandQuery?.('Feature')
    })
    await flushEffects()

    expect(testContainer.textContent).toContain('Feature workspace')
  })

  it('reseeds the repository filter when reopened during the close linger', async () => {
    const secondRepo = {
      ...makeRepo(),
      id: 'repo-2',
      path: '/repos/repo-2',
      displayName: 'Repo 2'
    }
    const first = makeWorktree('first', 'First repository workspace')
    const second = makeWorktree('second', 'Second repository workspace', { repoId: 'repo-2' })

    await renderPalette({
      repos: [makeRepo(), secondRepo],
      worktreesByRepo: { 'repo-1': [first], 'repo-2': [second] },
      filterRepoIds: ['repo-1'],
      showSleepingWorkspaces: true
    })

    expect(testContainer.textContent).toContain('First repository workspace')
    expect(testContainer.textContent).not.toContain('Second repository workspace')

    await act(async () => {
      useAppStore.setState({ activeModal: 'none', filterRepoIds: ['repo-2'] })
    })
    await flushEffects()
    await act(async () => useAppStore.getState().openModal('worktree-palette'))
    await flushEffects()

    expect(testContainer.textContent).not.toContain('First repository workspace')
    expect(testContainer.textContent).toContain('Second repository workspace')
  })

  // Host-qualified document/row/command keys must keep same-path workspaces on different hosts independently selectable (STA-4343).
  it('routes activation to each row own host when two same-id rows collide', async () => {
    const local = makeWorktree('shared', 'Local workspace', { hostId: 'local' })
    const ssh = makeWorktree('shared', 'SSH workspace', { hostId: 'ssh:box' })
    const state = {
      worktreesByRepo: { 'repo-1': [local, ssh] },
      showSleepingWorkspaces: true
    }

    await renderPalette(state)

    // Host-qualified command values keep both rows independently selectable.
    const rows = testContainer.querySelectorAll<HTMLButtonElement>(
      `[data-command-item^="${encodePaletteIdentity(['worktree'])}"]`
    )
    expect(rows).toHaveLength(2)
    expect([...rows].map((candidate) => candidate.getAttribute('data-command-item'))).toEqual([
      encodePaletteIdentity(['worktree', 'local|shared']),
      encodePaletteIdentity(['worktree', 'ssh:box|shared'])
    ])

    await act(async () => fireEvent.click(rows[0]!))
    expect(activateAndRevealWorkspace).toHaveBeenLastCalledWith('shared', {
      navigationIntent: 'user-open',
      executionHostId: 'local'
    })
  })

  // Use a fresh render because activation closes the palette and detaches the sibling row.
  it('routes the second same-id row to the other host', async () => {
    const local = makeWorktree('shared', 'Local workspace', { hostId: 'local' })
    const ssh = makeWorktree('shared', 'SSH workspace', { hostId: 'ssh:box' })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [local, ssh] },
      showSleepingWorkspaces: true
    })

    const rows = testContainer.querySelectorAll<HTMLButtonElement>(
      `[data-command-item^="${encodePaletteIdentity(['worktree'])}"]`
    )
    expect(rows).toHaveLength(2)

    await act(async () => fireEvent.click(rows[1]!))
    expect(activateAndRevealWorkspace).toHaveBeenLastCalledWith('shared', {
      navigationIntent: 'user-open',
      executionHostId: 'ssh:box'
    })
  })

  it('keeps the host in a lone row command value', async () => {
    const ssh = makeWorktree('single', 'SSH workspace', { hostId: 'ssh:box' })

    await renderPalette({ worktreesByRepo: { 'repo-1': [ssh] }, showSleepingWorkspaces: true })

    expect(
      testContainer.querySelector(
        `[data-command-item="${encodePaletteIdentity(['worktree', 'ssh:box|single'])}"]`
      )?.textContent
    ).toContain('SSH workspace')
  })

  it('routes same-target SSH rows through their paired runtime owner', async () => {
    const hubA = makeWorktree('shared-runtime', 'Hub A workspace', {
      hostId: 'ssh:same-private-target',
      runtimeOwnerEnvironmentId: 'hub-a'
    })
    const hubB = makeWorktree('shared-runtime', 'Hub B workspace', {
      hostId: 'ssh:same-private-target',
      runtimeOwnerEnvironmentId: 'hub-b'
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [hubA, hubB] },
      showSleepingWorkspaces: true
    })
    await act(async () => setCommandQuery?.('workspace'))
    await flushEffects()

    const hubARow = testContainer.querySelector<HTMLButtonElement>(
      `[data-command-item="${encodePaletteIdentity(['worktree', 'runtime:hub-a|shared-runtime'])}"]`
    )
    const hubBRow = testContainer.querySelector(
      `[data-command-item="${encodePaletteIdentity(['worktree', 'runtime:hub-b|shared-runtime'])}"]`
    )
    expect(hubARow).not.toBeNull()
    expect(hubBRow).not.toBeNull()

    await act(async () => fireEvent.click(hubARow!))
    expect(activateAndRevealWorkspace).toHaveBeenLastCalledWith('shared-runtime', {
      navigationIntent: 'user-open',
      executionHostId: 'runtime:hub-a'
    })
  })

  it('does not badge a runtime-owned row with its physical SSH repo', async () => {
    const worktree = makeWorktree('runtime-repo', 'Runtime workspace', {
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'missing-runtime'
    })

    await renderPalette({
      repos: [{ ...makeRepo(), displayName: 'Physical SSH repo', executionHostId: 'ssh:box' }],
      worktreesByRepo: { 'repo-1': [worktree] },
      showSleepingWorkspaces: true
    })

    const row = testContainer.querySelector(
      `[data-command-item="${encodePaletteIdentity(['worktree', 'runtime:missing-runtime|runtime-repo'])}"]`
    )
    expect(row?.textContent).toContain('Runtime workspace')
    expect(row?.textContent).not.toContain('Physical SSH repo')
  })

  it('replaces a completed emoji shortcode in the search query', async () => {
    await renderPalette({ worktreesByRepo: { 'repo-1': [] } })
    const input = testContainer.querySelector<HTMLInputElement>('[data-command-input="true"]')
    expect(input).not.toBeNull()

    await act(async () => {
      fireEvent.change(input!, { target: { value: ':wink:', selectionStart: 6 } })
    })

    expect(input?.value).toBe('😉')
  })

  it('renders last active timestamp when worktree has lastActivityAt', async () => {
    const twentyThreeDaysAgo = Date.now() - 23 * 24 * 60 * 60 * 1000
    const activeWorktree = makeWorktree('active-wt', 'Active workspace', {
      lastActivityAt: twentyThreeDaysAgo
    })
    const noActivityWorktree = makeWorktree('no-activity-wt', 'No activity workspace', {
      lastActivityAt: 0
    })

    await renderPalette({
      worktreesByRepo: { 'repo-1': [activeWorktree, noActivityWorktree] },
      showSleepingWorkspaces: true
    })

    const activeRow = testContainer.querySelector(
      `[data-command-item="${encodePaletteIdentity(['worktree', '|active-wt'])}"]`
    )
    expect(activeRow?.textContent).toContain('23d')
    const activeSpan = activeRow?.querySelector('span[aria-label="Last active 23d ago"]')
    expect(activeSpan).not.toBeNull()
    expect(activeSpan?.textContent).toBe('23d')

    const noActivityRow = testContainer.querySelector(
      `[data-command-item="${encodePaletteIdentity(['worktree', '|no-activity-wt'])}"]`
    )
    expect(noActivityRow?.querySelector('span[aria-label*="Last active"]')).toBeNull()
  })
})
