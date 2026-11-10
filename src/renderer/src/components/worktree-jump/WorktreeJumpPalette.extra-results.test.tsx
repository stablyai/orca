// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactI18Next from 'react-i18next'
import { useAppStore } from '@/store/index'
import type { AppState } from '@/store/types'

import WorktreeJumpPalette from './WorktreeJumpPalette'
import { encodePaletteIdentity } from '../../../../shared/palette-match/palette-ranking'
import { makeRecentTabState, makeRepo, makeWorktree } from './worktree-jump-palette-test-fixtures'
import {
  matchPaletteExtraFields,
  type PaletteExtraResult,
  type PaletteExtraSource
} from '@/components/cmd-j/palette-extra-results'

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

const extra = vi.hoisted(() => {
  const state: {
    titles: string[]
    leadsOnTie: boolean
    hiddenWorktreeId: string | null
    onSelect: ReturnType<typeof vi.fn<(title: string) => void>>
  } = { titles: [], leadsOnTie: false, hiddenWorktreeId: null, onSelect: vi.fn() }
  return state
})

function fakeResults({ query }: { query: string }): readonly PaletteExtraResult[] {
  return extra.titles.flatMap((title, order): PaletteExtraResult[] => {
    const base = {
      id: title,
      title,
      lastActiveAt: null,
      order,
      onSelect: () => extra.onSelect(title)
    }
    if (!query) {
      return [{ ...base, titleRanges: [], rank: null, qualityClass: null }]
    }
    const match = matchPaletteExtraFields(
      title,
      [{ id: 'title', text: title, role: 'primary' }],
      query
    )
    return match
      ? [
          {
            ...base,
            titleRanges: match.rangesByField.get('title') ?? [],
            rank: match.rank,
            qualityClass: match.qualityClass
          }
        ]
      : []
  })
}

vi.mock('@/components/cmd-j/palette-extra-sources', async () => {
  const React = await import('react')
  return {
    usePaletteExtraSources: ({ query }: { query: string }): readonly PaletteExtraSource[] => {
      const results = React.useMemo(() => fakeResults({ query }), [query])
      return React.useMemo(
        () => [
          {
            id: 'fake',
            sectionLabel: () => 'Extras',
            emptyQueryCap: 2,
            typedPlacement: 'after-workspaces',
            leadsOnTie: extra.leadsOnTie,
            results,
            hidesWorkspace: (worktree) => worktree.id === extra.hiddenWorktreeId
          }
        ],
        [results]
      )
    }
  }
})

vi.mock('@/components/ui/command', async () => {
  const React = await import('react')
  return {
    Command: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    CommandGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
    CommandInput: ({
      value,
      onValueChange,
      placeholder
    }: {
      value?: string
      onValueChange?: (next: string) => void
      placeholder?: string
    }) => {
      setCommandQuery = onValueChange ?? null
      return (
        <input
          data-command-input="true"
          placeholder={placeholder}
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
    alwaysShowDefaultBranchWorkspace: true,
    showSleepingWorkspaces: true,
    lastVisitedAtByWorktreeId: {},
    ...overrides
  })
  await act(async () => {
    testRoot.render(<WorktreeJumpPalette />)
  })
  await flushEffects()
}

async function typeQuery(query: string): Promise<void> {
  await act(async () => {
    setCommandQuery?.(query)
  })
  await flushEffects()
}

const EXTRA_PREFIX = encodePaletteIdentity(['extra'])
const WORKTREE_PREFIX = encodePaletteIdentity(['worktree'])
const TAB_PREFIX = encodePaletteIdentity(['workspace-tab'])

function rowKinds(): string[] {
  return [...testContainer.querySelectorAll<HTMLElement>('[data-command-item]')]
    .map((node) => node.dataset.commandItem ?? '')
    .map((id) =>
      id.startsWith(EXTRA_PREFIX)
        ? 'extra'
        : id.startsWith(WORKTREE_PREFIX)
          ? 'worktree'
          : id.startsWith(TAB_PREFIX)
            ? 'tab'
            : 'other'
    )
    .filter((kind) => kind !== 'other')
}

function extraRow(title: string): HTMLElement | undefined {
  return [
    ...testContainer.querySelectorAll<HTMLElement>(`[data-command-item^="${EXTRA_PREFIX}"]`)
  ].find((node) => node.textContent?.includes(title))
}

function workspaceNamed(displayName: string): Partial<AppState> {
  return { worktreesByRepo: { 'repo-1': [makeWorktree('wt-notes', displayName)] } }
}

describe('WorktreeJumpPalette extra result sources', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    setCommandQuery = null
    extra.titles = ['Triage helper']
    extra.leadsOnTie = false
    extra.hiddenWorktreeId = null
    extra.onSelect.mockClear()
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

  it('leads on a strictly better match', async () => {
    // A whole-word hit outranks the workspace's word-prefix hit.
    await renderPalette(workspaceNamed('Triager notes'))
    await typeQuery('triage')
    expect(rowKinds()).toEqual(['extra', 'worktree'])
    // Enter targets the leading row.
    expect(
      testContainer.querySelector<HTMLElement>('[data-command-dialog]')?.dataset.commandValue
    ).toBe(extraRow('Triage helper')?.dataset.commandItem)
  })

  it('follows workspaces on a tie', async () => {
    await renderPalette(workspaceNamed('Triage notes'))
    await typeQuery('triage')
    expect(rowKinds()).toEqual(['worktree', 'extra'])
  })

  it('leads on a tie when the source prefers ties', async () => {
    extra.leadsOnTie = true
    await renderPalette(workspaceNamed('Triage notes'))

    await typeQuery('triage')
    expect(rowKinds()).toEqual(['extra', 'worktree'])
  })

  it('counts extra rows in the announced result count', async () => {
    await renderPalette(workspaceNamed('Release notes'))
    await typeQuery('triage')
    expect(rowKinds()).toEqual(['extra'])
    expect(testContainer.textContent).toContain('1 result found.')
  })

  it('caps empty-query rows after recent workspaces and runs onSelect on Enter', async () => {
    extra.titles = ['First', 'Second', 'Third']
    await renderPalette(workspaceNamed('Triage notes'))

    expect(rowKinds()).toEqual(['worktree', 'extra', 'extra'])
    expect(testContainer.textContent).toContain('Extras')
    expect(testContainer.textContent).toContain('1 more')
    expect(extraRow('Third')).toBeUndefined()

    await act(async () => {
      extraRow('First')?.click()
    })
    expect(extra.onSelect).toHaveBeenCalledWith('First')
    expect(useAppStore.getState().activeModal).not.toBe('worktree-palette')
  })

  it('hides a workspace the source represents but keeps its tabs in recents', async () => {
    extra.titles = []
    extra.hiddenWorktreeId = 'wt-alpha'
    await renderPalette(makeRecentTabState())

    const worktreeIds = [
      ...testContainer.querySelectorAll<HTMLElement>(`[data-command-item^="${WORKTREE_PREFIX}"]`)
    ].map((node) => node.dataset.commandItem ?? '')
    expect(worktreeIds.some((id) => id.includes('wt-alpha'))).toBe(false)
    expect(worktreeIds.some((id) => id.includes('wt-beta'))).toBe(true)
    expect(testContainer.textContent).toContain('Alpha chat')
  })
})
