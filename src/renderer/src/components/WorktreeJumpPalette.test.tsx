// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { encodePaletteIdentity } from '@/lib/palette-match/palette-ranking'
import { emitCmdJRowIndexJump } from '@/lib/cmd-j-row-index-jump'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { getLocalExecutionHostLabel } from '../../../shared/execution-host'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import {
  LEAF_ID,
  makeAgentEntry,
  makeGroup,
  makeRepo,
  makeTerminalTab,
  makeUnifiedTab,
  makeWorktree
} from './worktree-jump-palette-test-fixtures'

const { activateAndRevealWorktree } = vi.hoisted(() => ({
  activateAndRevealWorktree: vi.fn(() => false)
}))

vi.mock('@/lib/worktree-activation', () => ({ activateAndRevealWorktree }))

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

// Why: activation reaches into window.api and the whole worktree-reveal path; the palette's own
// contract is which result it hands over, so stub the boundary and assert on that.
const { activateWorkspaceTabPaletteResult } = vi.hoisted(() => ({
  activateWorkspaceTabPaletteResult: vi.fn((_result: unknown) => ({ status: 'activated' }) as const)
}))
vi.mock('@/lib/workspace-tab-palette-activation', () => ({
  activateWorkspaceTabPaletteResult: (result: unknown) => activateWorkspaceTabPaletteResult(result)
}))

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    // Why the commandProps passthrough: cmdk resolves Enter against its `value`, so the controlled
    // value is the only honest stand-in for "what would Enter activate" without mounting real cmdk.
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
        onKeyDown,
        trailing
      }: {
        value?: string
        onValueChange?: (next: string) => void
        placeholder?: string
        onClick?: React.MouseEventHandler<HTMLInputElement>
        onSelect?: React.ReactEventHandler<HTMLInputElement>
        onKeyDown?: React.KeyboardEventHandler<HTMLInputElement>
        trailing?: React.ReactNode
      },
      ref: React.ForwardedRef<HTMLInputElement>
    ) {
      setCommandQuery = onValueChange ?? null
      return (
        <>
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
          {trailing}
        </>
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

function getSessionRows(): string[] {
  return [
    ...testContainer.querySelectorAll<HTMLElement>(
      `[data-command-item^="${encodePaletteIdentity(['workspace-tab'])}"]`
    )
  ].map((node) => node.textContent ?? '')
}

async function clickFilterButton(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent?.trim() === label
  )
  if (!button) {
    throw new Error(`Filter button not found: ${label}`)
  }
  await act(async () => fireEvent.click(button))
  await flushEffects()
}

async function openFilterMenu(): Promise<void> {
  const trigger = testContainer.querySelector<HTMLButtonElement>('[aria-label="Filter results"]')
  if (!trigger) {
    throw new Error('Filter results trigger not found')
  }
  await act(async () => fireEvent.click(trigger))
  await flushEffects()
}

async function selectFilterOption(
  field: string,
  query: string,
  skipPinnedOptions = 0
): Promise<void> {
  const category = [...document.querySelectorAll<HTMLButtonElement>('[data-command-item]')].find(
    (candidate) => candidate.textContent?.startsWith(field)
  )
  if (category) {
    await act(async () => fireEvent.click(category))
    await flushEffects()
  }
  // Search + Enter exercises the real option keyboard path without depending on DOM layout
  // measurements from the virtual list in happy-dom.
  const input = document.querySelector<HTMLInputElement>('input[aria-label^="Filter"]')
  if (!input) {
    throw new Error(`Filter search input not found for ${field}`)
  }
  await act(async () => fireEvent.change(input, { target: { value: query } }))
  // Selected options remain pinned ahead of search matches.
  for (let index = 0; index < skipPinnedOptions; index++) {
    await act(async () => fireEvent.keyDown(input, { key: 'ArrowDown' }))
  }
  await act(async () => fireEvent.keyDown(input, { key: 'Enter' }))
  await flushEffects()
}

function makeStatusFilterState(): Partial<AppState> {
  const rows = [
    {
      id: 'waiting',
      label: 'Session waiting chat',
      repoId: 'repo-1',
      hostId: 'local',
      state: 'blocked'
    },
    {
      id: 'done',
      label: 'Session completed chat',
      repoId: 'repo-1',
      hostId: 'local',
      state: 'done'
    },
    {
      id: 'other-project',
      label: 'Session other project',
      repoId: 'repo-2',
      hostId: 'local',
      state: 'done'
    },
    {
      id: 'remote',
      label: 'Session remote chat',
      repoId: 'repo-3',
      hostId: 'ssh:box',
      state: 'done'
    },
    {
      id: 'running',
      label: 'Session running chat',
      repoId: 'repo-1',
      hostId: 'local',
      state: 'working'
    },
    {
      id: 'old-unread',
      label: 'Session old unread terminal',
      repoId: 'repo-1',
      hostId: 'local',
      state: null
    },
    { id: 'shell', label: 'Session plain shell', repoId: 'repo-1', hostId: 'local', state: null }
  ] as const
  const worktrees = rows.map((row) =>
    makeWorktree(row.id, `Workspace ${row.id}`, { repoId: row.repoId, hostId: row.hostId })
  )
  return {
    repos: [
      { ...makeRepo(), displayName: 'Project One', executionHostId: 'local' },
      {
        ...makeRepo(),
        id: 'repo-2',
        path: '/repos/repo-2',
        displayName: 'Project Two',
        executionHostId: 'local'
      },
      {
        ...makeRepo(),
        id: 'repo-3',
        path: '/repos/repo-3',
        displayName: 'Remote Project',
        executionHostId: 'ssh:box'
      }
    ],
    worktreesByRepo: {
      'repo-1': worktrees.filter((worktree) => worktree.repoId === 'repo-1'),
      'repo-2': worktrees.filter((worktree) => worktree.repoId === 'repo-2'),
      'repo-3': worktrees.filter((worktree) => worktree.repoId === 'repo-3')
    },
    showSleepingWorkspaces: true,
    tabsByWorktree: Object.fromEntries(
      rows.map((row) => [row.id, [makeTerminalTab(`term-${row.id}`, row.id, row.label)]])
    ),
    unifiedTabsByWorktree: Object.fromEntries(
      rows.map((row) => [
        row.id,
        [
          {
            ...makeUnifiedTab(`tab-${row.id}`, row.id, `term-${row.id}`, row.label),
            lastFocusedAt: Date.now() - (row.id === 'old-unread' ? 30 * 86400_000 : 0)
          }
        ]
      ])
    ),
    groupsByWorktree: Object.fromEntries(
      rows.map((row) => [row.id, [makeGroup(row.id, [`tab-${row.id}`])]])
    ),
    activeGroupIdByWorktree: Object.fromEntries(rows.map((row) => [row.id, `group-${row.id}`])),
    ptyIdsByTabId: Object.fromEntries(
      rows.map((row) => [`term-${row.id}`, [`pty-term-${row.id}`]])
    ),
    agentStatusByPaneKey: Object.fromEntries(
      rows.flatMap((row) =>
        row.state == null
          ? []
          : [
              [
                makePaneKey(`term-${row.id}`, LEAF_ID),
                makeAgentEntry(`term-${row.id}`, row.state, Date.now())
              ]
            ]
      )
    ),
    unreadTerminalTabs: { 'term-running': true, 'term-old-unread': true },
    browserTabsByWorktree: {
      shell: [
        {
          id: 'browser-status-test',
          worktreeId: 'shell',
          activePageId: 'page-status-test',
          pageIds: ['page-status-test'],
          url: 'https://example.com/session',
          title: 'Session browser',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 0
        }
      ]
    },
    browserPagesByWorkspace: {
      'browser-status-test': [
        {
          id: 'page-status-test',
          workspaceId: 'browser-status-test',
          worktreeId: 'shell',
          url: 'https://example.com/session',
          title: 'Session browser',
          loading: false,
          faviconUrl: null,
          canGoBack: false,
          canGoForward: false,
          loadError: null,
          createdAt: 0
        }
      ]
    }
  }
}

describe('WorktreeJumpPalette', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    activateWorkspaceTabPaletteResult.mockClear()
    setCommandQuery = null
    activateAndRevealWorktree.mockClear()
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
    // Why kept: the exemption keys on isMainWorktree, not the branch name, so a
    // branchless folder workspace is the project's entry point too.
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
    // Why kept: same isMainWorktree exemption — folder workspaces are covered.
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

  // STA-4343 closed: two workspaces sharing `repoId::path` across hosts are two distinct
  // rows. The documents map and worktreeMap are keyed by host identity, so each row resolves
  // to its OWN worktree, and render keys keep the two apart for React and cmdk.
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

    // The first row names ITS OWN host — the wrong-host open is gone.
    await act(async () => fireEvent.click(rows[0]!))
    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('shared', {
      navigationIntent: 'user-open',
      executionHostId: 'local'
    })
  })

  // Why a separate render: activating closes the palette, so the sibling row is detached
  // before a second click in the same test could reach it.
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
    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('shared', {
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
    expect(activateAndRevealWorktree).toHaveBeenLastCalledWith('shared-runtime', {
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

  it('unions session statuses for empty and typed queries without unrelated result pollution', async () => {
    await renderPalette(makeStatusFilterState())
    expect(getSessionRows().length).toBeGreaterThan(0)
    expect(getWorktreeRows()).not.toEqual([])

    await openFilterMenu()
    await selectFilterOption('Status', 'Waiting for input')
    await selectFilterOption('Status', 'Finished', 1)

    const expected = [
      'Session waiting chat',
      'Session completed chat',
      'Session other project',
      'Session remote chat',
      'Session old unread terminal'
    ]
    expect(getSessionRows()).toEqual(expected.map((label) => expect.stringContaining(label)))
    expect(getSessionRows()).not.toContainEqual(expect.stringContaining('Session running chat'))
    expect(getSessionRows()).not.toContainEqual(expect.stringContaining('Session plain shell'))
    expect(getWorktreeRows()).toEqual([])
    expect(
      testContainer.querySelector(
        `[data-command-item^="${encodePaletteIdentity(['browser-page'])}"]`
      )
    ).toBeNull()

    await openFilterMenu()
    await act(async () => setCommandQuery?.('Session'))
    await flushEffects()
    expect(getSessionRows()).toHaveLength(expected.length)
    expect(getWorktreeRows()).toEqual([])
    expect(testContainer.textContent).not.toContain('Session browser')

    await act(async () => setCommandQuery?.('new'))
    await flushEffects()
    expect(getSessionRows()).toEqual([])
    expect(testContainer.querySelector('[data-command-item]')).toBeNull()
  })

  it('intersects status with host and project choices, then clears and resets on reopen', async () => {
    await renderPalette(makeStatusFilterState())
    await openFilterMenu()
    await selectFilterOption('Status', 'Finished')
    await clickFilterButton('Back')
    await selectFilterOption('Hosts', getLocalExecutionHostLabel())
    expect(getSessionRows()).toHaveLength(3)
    expect(getSessionRows()).toContainEqual(expect.stringContaining('Session other project'))
    expect(getSessionRows()).not.toContainEqual(expect.stringContaining('Session remote chat'))
    await clickFilterButton('Back')
    await selectFilterOption('Projects', 'Project One')

    expect(getSessionRows()).toHaveLength(2)
    expect(getSessionRows()).toContainEqual(expect.stringContaining('Session completed chat'))
    expect(getSessionRows()).toContainEqual(expect.stringContaining('Session old unread terminal'))
    expect(getSessionRows()).not.toContainEqual(expect.stringContaining('Session remote chat'))
    expect(getSessionRows()).not.toContainEqual(expect.stringContaining('Session other project'))

    await openFilterMenu()
    await act(async () => setCommandQuery?.('Session'))
    await flushEffects()
    expect(getSessionRows()).toHaveLength(2)

    await openFilterMenu()
    await clickFilterButton('Clear all')
    await openFilterMenu()
    expect(getSessionRows()).toHaveLength(7)
    expect(testContainer.textContent).toContain('Session browser')

    await act(async () => setCommandQuery?.(''))
    await flushEffects()
    await openFilterMenu()
    await selectFilterOption('Status', 'Waiting for input')
    await openFilterMenu()
    expect(getSessionRows()).toHaveLength(1)
    await act(async () => useAppStore.setState({ activeModal: 'none' }))
    await flushEffects()
    await act(async () => useAppStore.getState().openModal('worktree-palette'))
    await flushEffects()
    expect(getSessionRows().length).toBeGreaterThan(2)
    expect(
      testContainer.querySelector('[aria-label="Filter results"]')?.getAttribute('data-active')
    ).toBeNull()
    expect(getWorktreeRows()).not.toEqual([])
  })

  it('routes numbered shortcuts to the filtered recent session rather than its old slot', async () => {
    await renderPalette(makeStatusFilterState())
    await openFilterMenu()
    await selectFilterOption('Status', 'Waiting for input')
    await openFilterMenu()
    expect(getSessionRows()).toHaveLength(1)
    expect(getSessionRows()[0]).toContain('Session waiting chat')

    await act(async () => emitCmdJRowIndexJump(1))
    await flushEffects()
    expect(activateWorkspaceTabPaletteResult).not.toHaveBeenCalled()
    await act(async () => emitCmdJRowIndexJump(0))
    await flushEffects()
    expect(activateWorkspaceTabPaletteResult).toHaveBeenCalledWith(
      expect.objectContaining({ tabId: 'tab-waiting' })
    )
  })
})
