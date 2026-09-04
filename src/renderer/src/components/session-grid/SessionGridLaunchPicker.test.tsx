// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { buildSessionGridWorktreeCatalog } from './session-grid-worktree-catalog'
import { SessionGridLaunchPopoverContent } from './SessionGridLaunchPicker'

const harness = vi.hoisted(() => ({
  launchAgentInNewTab: vi.fn((_args: Record<string, unknown>) => ({ tabId: 'tab-new' })),
  backgroundMount: vi.fn(),
  createTab: vi.fn((_worktreeId: string) => ({ id: 'tab-shell' })),
  onDone: vi.fn()
}))

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: harness.launchAgentInNewTab
}))
vi.mock('@/components/terminal/background-terminal-worktree-mount', () => ({
  requestBackgroundTerminalWorktreeMount: harness.backgroundMount
}))

// Radix mounts popover content only while open, and cmdk measures its list with a
// ResizeObserver happy-dom lacks; rendering both inline is how this repo asserts what a
// picker actually offers.
vi.mock('@/components/ui/popover', () => ({
  PopoverContent: ({ children }: { children: ReactNode }) => <div role="dialog">{children}</div>
}))
vi.mock('@/components/ui/command', () => ({
  Command: ({ children, ...rest }: { children: ReactNode }) => (
    <div data-command {...pickDataAttributes(rest)}>
      {children}
    </div>
  ),
  CommandInput: ({ placeholder }: { placeholder?: string }) => (
    <input data-slot="command-input" placeholder={placeholder} />
  ),
  CommandList: ({ children }: { children: ReactNode }) => <div role="listbox">{children}</div>,
  CommandEmpty: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CommandGroup: ({ children, heading }: { children: ReactNode; heading?: string }) => (
    <div role="group" aria-label={heading}>
      {heading ? <div data-heading>{heading}</div> : null}
      {children}
    </div>
  ),
  CommandItem: ({
    children,
    onSelect,
    disabled,
    ...rest
  }: {
    children: ReactNode
    onSelect?: () => void
    disabled?: boolean
  }) => (
    <button
      type="button"
      role="option"
      aria-selected={false}
      disabled={disabled}
      onClick={onSelect}
      {...pickDataAttributes(rest)}
    >
      {children}
    </button>
  ),
  CommandSeparator: () => <hr />
}))

function pickDataAttributes(props: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith('data-')))
}

function optionLabels(container: HTMLElement = document.body): string[] {
  return within(container)
    .queryAllByRole('option')
    .map((item) => item.textContent?.trim() ?? '')
}

function workspaceRows(): HTMLElement[] {
  return screen.queryAllByTestId('session-grid-launch-workspace')
}

function groupHeadings(): string[] {
  return Array.from(document.querySelectorAll('[data-heading]')).map(
    (node) => node.textContent ?? ''
  )
}

const SYTIO_REPO = [{ id: 'repo-1', displayName: 'sytio', path: '/s' }] as unknown as Repo[]

beforeEach(() => {
  useAppStore.setState({
    repos: [],
    worktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    activeWorktreeId: null,
    detectedAgentIds: [],
    remoteDetectedAgentIds: {},
    runtimeDetectedAgentIds: {},
    settings: { defaultTuiAgent: null, disabledTuiAgents: [] } as never,
    createTab: harness.createTab as never,
    ensureDetectedAgents: vi.fn() as never,
    ensureRemoteDetectedAgents: vi.fn() as never,
    ensureRuntimeDetectedAgents: vi.fn() as never
  })
})

afterEach(() => {
  cleanup()
  harness.launchAgentInNewTab.mockClear()
  harness.backgroundMount.mockClear()
  harness.createTab.mockClear()
  harness.onDone.mockClear()
})

describe('SessionGridLaunchPopoverContent', () => {
  it('offers nothing selectable when every repo group is empty', () => {
    const worktreeCatalog = buildSessionGridWorktreeCatalog({
      worktreesByRepo: { 'repo-1': [] } as unknown as Record<string, Worktree[]>,
      repos: SYTIO_REPO
    })

    render(
      <SessionGridLaunchPopoverContent
        activeFilter="all"
        worktreeCatalog={worktreeCatalog}
        gridWorktreeIds={[]}
        onDone={harness.onDone}
      />
    )

    expect(optionLabels()).toEqual([])
  })

  it('skips the workspace step when the grid is filtered to one, default agent first', () => {
    useAppStore.setState({
      repos: SYTIO_REPO,
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', displayName: 'sytio', path: '/s' }]
      } as unknown as Record<string, Worktree[]>,
      detectedAgentIds: ['claude', 'codex', 'gemini'] as never,
      settings: { defaultTuiAgent: 'codex', disabledTuiAgents: ['gemini'] } as never
    })
    const worktreeCatalog = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', displayName: 'sytio', path: '/s' }]
      } as unknown as Record<string, Worktree[]>,
      repos: SYTIO_REPO
    })

    render(
      <SessionGridLaunchPopoverContent
        activeFilter="wt-1"
        worktreeCatalog={worktreeCatalog}
        gridWorktreeIds={['wt-1']}
        onDone={harness.onDone}
      />
    )

    expect(workspaceRows()).toEqual([])
    // Disabled agents excluded, the default first, the shell after the agents.
    expect(optionLabels()).toEqual(['CodexDefault', 'Claude', 'Terminal Shell', 'Agent settings…'])
    // No back affordance: the grid named the workspace, the user did not pick it here.
    expect(screen.queryByRole('button', { name: 'Back to workspaces' })).toBeNull()
  })

  /**
   * Step one leads with the workspaces already on the grid, the active one first, and lists
   * everything else under its project — once each, so a search cannot show one workspace
   * under two headings.
   */
  it('leads with the grid’s own workspaces and groups the rest by project, listing each once', () => {
    const worktrees = {
      'repo-1': [
        { id: 'wt-main', repoId: 'repo-1', displayName: 'main', branch: 'main', path: '/s' },
        { id: 'wt-feat', repoId: 'repo-1', displayName: 'feat', branch: 'feat', path: '/s-feat' }
      ],
      'repo-2': [{ id: 'wt-other', repoId: 'repo-2', displayName: 'other', path: '/o' }]
    } as unknown as Record<string, Worktree[]>
    const repos = [
      { id: 'repo-1', displayName: 'sytio', path: '/s' },
      { id: 'repo-2', displayName: 'other', path: '/o' }
    ] as unknown as Repo[]
    useAppStore.setState({ repos, worktreesByRepo: worktrees })
    const worktreeCatalog = buildSessionGridWorktreeCatalog({ worktreesByRepo: worktrees, repos })

    render(
      <SessionGridLaunchPopoverContent
        activeFilter="all"
        defaultWorktreeId="wt-feat"
        worktreeCatalog={worktreeCatalog}
        gridWorktreeIds={['wt-main', 'wt-feat']}
        onDone={harness.onDone}
      />
    )

    expect(groupHeadings()).toEqual(['In this grid', 'other'])
    expect(workspaceRows().map((row) => row.textContent)).toEqual([
      'sytio / feat',
      'sytio / main',
      'other'
    ])
  })

  it('walks from a workspace to its launch targets and back', () => {
    useAppStore.setState({
      repos: SYTIO_REPO,
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', displayName: 'sytio', path: '/s' }]
      } as unknown as Record<string, Worktree[]>,
      detectedAgentIds: ['claude'] as never
    })
    const worktreeCatalog = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', displayName: 'sytio', path: '/s' }]
      } as unknown as Record<string, Worktree[]>,
      repos: SYTIO_REPO
    })

    render(
      <SessionGridLaunchPopoverContent
        activeFilter="all"
        worktreeCatalog={worktreeCatalog}
        gridWorktreeIds={[]}
        onDone={harness.onDone}
      />
    )

    fireEvent.click(workspaceRows()[0]!)
    expect(screen.getByTestId('session-grid-launch-targets')).toHaveAttribute(
      'data-execution-host',
      'local'
    )
    expect(optionLabels()).toEqual(['Claude', 'Terminal Shell', 'Agent settings…'])

    fireEvent.click(screen.getByRole('button', { name: 'Back to workspaces' }))
    expect(workspaceRows()).toHaveLength(1)
  })

  /**
   * `worktreeId` is `repoId::path` with no host component, so a repo attached both locally and
   * over SSH publishes the same id twice (store/worktree-repo-index.ts:29). Each host gets its
   * own row, named, and a launch goes to the host whose row was picked.
   */
  describe('a workspace two hosts publish under the same id', () => {
    const LOCAL_ROW = { id: 'wt-1', repoId: 'repo-1', displayName: 'sytio', path: '/s' }
    const SSH_ROW = { ...LOCAL_ROW, hostId: 'ssh:conn-1' }

    function renderBothHosts(gridWorktreeIds: string[] = [], activeFilter = 'all'): void {
      useAppStore.setState({
        repos: [
          { id: 'repo-1', displayName: 'sytio', path: '/s' },
          { id: 'repo-1', displayName: 'sytio', path: '/s', connectionId: 'conn-1' }
        ] as unknown as Repo[],
        worktreesByRepo: { 'repo-1': [LOCAL_ROW, SSH_ROW] } as unknown as Record<
          string,
          Worktree[]
        >,
        detectedAgentIds: ['claude'] as never,
        remoteDetectedAgentIds: { 'conn-1': ['gemini'] } as never
      })
      const worktreeCatalog = buildSessionGridWorktreeCatalog({
        worktreesByRepo: { 'repo-1': [LOCAL_ROW, SSH_ROW] } as unknown as Record<
          string,
          Worktree[]
        >,
        repos: SYTIO_REPO,
        sshTargetLabels: new Map([['conn-1', 'build box']])
      })
      render(
        <SessionGridLaunchPopoverContent
          activeFilter={activeFilter}
          worktreeCatalog={worktreeCatalog}
          gridWorktreeIds={gridWorktreeIds}
          onDone={harness.onDone}
        />
      )
    }

    function rowForHost(executionHostId: string): HTMLElement {
      const row = document.querySelector<HTMLElement>(
        `[data-testid="session-grid-launch-workspace"][data-execution-host="${executionHostId}"]`
      )
      if (!row) {
        throw new Error(`no workspace row for execution host ${executionHostId}`)
      }
      return row
    }

    it('gives each host its own row instead of collapsing them into one', () => {
      renderBothHosts()

      expect(workspaceRows()).toHaveLength(2)
      // Two rows reading only "sytio" would be a coin flip; the remote one names its host.
      expect(rowForHost('ssh:conn-1').textContent).toContain('build box')
    })

    it('retains both launch hosts for a workspace already in the grid', () => {
      renderBothHosts(['wt-1'])
      expect(workspaceRows()).toHaveLength(2)
      expect(rowForHost('local')).toBeTruthy()
      expect(rowForHost('ssh:conn-1')).toBeTruthy()
    })

    it('asks for the host when the workspace filter is ambiguous', () => {
      renderBothHosts(['wt-1'], 'wt-1')
      expect(workspaceRows()).toHaveLength(2)
      fireEvent.click(rowForHost('ssh:conn-1'))
      expect(optionLabels()).toEqual(['Gemini', 'Terminal Shell', 'Agent settings…'])
    })

    it('lists the picked host’s own detected agents', () => {
      renderBothHosts()

      fireEvent.click(rowForHost('ssh:conn-1'))
      expect(optionLabels()).toEqual(['Gemini', 'Terminal Shell', 'Agent settings…'])
    })

    it('launches an agent on the host whose row it was picked from', () => {
      renderBothHosts()

      fireEvent.click(rowForHost('ssh:conn-1'))
      fireEvent.click(screen.getByRole('option', { name: 'Gemini' }))

      expect(harness.launchAgentInNewTab).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: 'gemini',
          worktreeId: 'wt-1',
          executionHostId: 'ssh:conn-1'
        })
      )
      expect(harness.onDone).toHaveBeenCalledTimes(1)
    })

    it('opens a plain shell on the host whose row it was picked from', () => {
      renderBothHosts()

      fireEvent.click(rowForHost('ssh:conn-1'))
      fireEvent.click(screen.getByRole('option', { name: 'Terminal Shell' }))

      expect(harness.createTab).toHaveBeenLastCalledWith(
        'wt-1',
        undefined,
        undefined,
        expect.objectContaining({ executionHostId: 'ssh:conn-1' })
      )
      expect(harness.onDone).toHaveBeenCalledTimes(1)
    })
  })

  /**
   * What this can see: the arguments the picker hands each launch path. What it CANNOT see:
   * whether the foreground moved — `launchAgentInNewTab` and `createTab` are mocks with no
   * effects here. The foreground itself is watched against the real store in
   * session-grid-background-launch.test.ts.
   */
  it('hands both launch paths a background launch and the grid’s own mount', () => {
    useAppStore.setState({
      repos: SYTIO_REPO,
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1', displayName: 'sytio', path: '/s' }]
      } as unknown as Record<string, Worktree[]>,
      detectedAgentIds: ['claude'] as never
    })
    const worktreeCatalog = buildSessionGridWorktreeCatalog({
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', displayName: 'sytio', path: '/s' }]
      } as unknown as Record<string, Worktree[]>,
      repos: SYTIO_REPO
    })

    render(
      <SessionGridLaunchPopoverContent
        activeFilter="wt-1"
        worktreeCatalog={worktreeCatalog}
        gridWorktreeIds={['wt-1']}
        onDone={harness.onDone}
      />
    )

    fireEvent.click(screen.getByRole('option', { name: 'Claude' }))

    expect(harness.launchAgentInNewTab).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: 'claude',
        worktreeId: 'wt-1',
        launchSource: 'session_grid',
        activate: false
      })
    )
    // No groupId: the grid has no tab group to launch into.
    expect(harness.launchAgentInNewTab.mock.lastCall?.[0]).not.toHaveProperty('groupId')
    expect(harness.backgroundMount).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      tabIds: ['tab-new']
    })

    fireEvent.click(screen.getByRole('option', { name: 'Terminal Shell' }))

    expect(harness.createTab).toHaveBeenLastCalledWith(
      'wt-1',
      undefined,
      undefined,
      expect.objectContaining({ activate: false })
    )
    expect(harness.backgroundMount).toHaveBeenLastCalledWith({
      worktreeId: 'wt-1',
      tabIds: ['tab-shell']
    })
  })
})
