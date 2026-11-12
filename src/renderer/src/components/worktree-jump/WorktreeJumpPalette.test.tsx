// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import type { activateAndRevealWorkspace as ActivateWorkspace } from '@/lib/workspace/activation/worktree-activation'
import type { WorkspaceTabPaletteActivationResult } from '@/lib/workspace/search/tabs/workspace-tab-palette-activation'
import type { PaletteExtraSource } from '@/components/cmd-j/palette-extra-results'
import WorktreeJumpPalette from './WorktreeJumpPalette'
import { makeFolderWorkspace, makeRepo, makeWorktree } from './worktree-jump-palette-test-fixtures'

const { activateAndRevealWorkspace } = vi.hoisted(() => ({
  activateAndRevealWorkspace: vi.fn<typeof ActivateWorkspace>(() => ({ primaryTabId: null }))
}))

vi.mock('@/lib/workspace/activation/worktree-activation', () => ({ activateAndRevealWorkspace }))

const extraSources = vi.hoisted((): { current: readonly PaletteExtraSource[] } => ({ current: [] }))
vi.mock('@/components/cmd-j/palette-extra-sources', () => ({
  usePaletteExtraSources: () => extraSources.current
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

// Stub activation at its boundary; the palette contract is which result it hands over.
const { activateWorkspaceTabPaletteResult } = vi.hoisted(() => ({
  activateWorkspaceTabPaletteResult: vi.fn(
    (_result: unknown): WorkspaceTabPaletteActivationResult => ({ status: 'activated' })
  )
}))
vi.mock('@/lib/workspace/search/tabs/workspace-tab-palette-activation', () => ({
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
    extraSources.current = []
    activateAndRevealWorkspace.mockReset().mockReturnValue({ primaryTabId: null })
    activateWorkspaceTabPaletteResult.mockReset().mockReturnValue({ status: 'activated' })
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

  it.each([
    [undefined, ['worktree', 'extra']],
    ['first', ['extra', 'worktree']]
  ] as const)(
    'lists an extra source by its empty-query placement (%s) and keeps Enter on the workspace',
    async (emptyQueryPlacement, order) => {
      extraSources.current = [
        {
          id: 'notes',
          sectionLabel: () => 'Notes',
          emptyQueryCap: 3,
          emptyQueryPlacement,
          typedPlacement: 'after-workspaces',
          leadsOnTie: false,
          results: [
            {
              id: 'note-1',
              title: 'Release note',
              titleRanges: [],
              rank: null,
              qualityClass: null,
              lastActiveAt: null,
              order: 0,
              line: 'Draft',
              onSelect: () => {}
            }
          ]
        }
      ]
      await renderPalette({
        worktreesByRepo: { 'repo-1': [makeWorktree('wt-1', 'Checkout')] },
        showSleepingWorkspaces: true
      })
      const rows = [...testContainer.querySelectorAll<HTMLElement>('[data-command-item]')].map(
        (node) => node.dataset.commandItem
      )
      const worktreeId = encodePaletteIdentity(['worktree', '|wt-1'])
      const extraId = encodePaletteIdentity(['extra', 'notes', 'note-1'])
      expect(rows).toEqual(order.map((kind) => (kind === 'worktree' ? worktreeId : extraId)))
      expect(
        testContainer.querySelector('[data-command-dialog]')?.getAttribute('data-command-value')
      ).toBe(worktreeId)
    }
  )

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
})
