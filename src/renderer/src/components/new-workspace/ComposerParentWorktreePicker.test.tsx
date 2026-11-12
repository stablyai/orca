// @vitest-environment happy-dom

import type React from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'

type FakeStoreState = {
  worktreesByRepo: Record<string, Worktree[]>
  repos: Repo[]
  projectHostSetups: never[]
  worktreeLineageById: Record<string, WorktreeLineage>
  workspaceLineageByChildKey: Record<string, WorkspaceLineage>
}

const storeState = vi.hoisted(
  () =>
    ({
      worktreesByRepo: {},
      repos: [],
      projectHostSetups: [],
      worktreeLineageById: {},
      workspaceLineageByChildKey: {}
    }) as FakeStoreState
)

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback })
}))

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: FakeStoreState) => unknown) => selector(storeState)
}))

vi.mock('@/components/ui/popover', async () => {
  const { cloneElement, createContext, useContext, useMemo } = await import('react')
  const PopoverState = createContext<{ open: boolean; onOpenChange?: (open: boolean) => void }>({
    open: false
  })
  return {
    Popover: ({
      children,
      open = false,
      onOpenChange
    }: {
      children: React.ReactNode
      open?: boolean
      onOpenChange?: (open: boolean) => void
    }) => {
      const value = useMemo(() => ({ open, onOpenChange }), [open, onOpenChange])
      return <PopoverState.Provider value={value}>{children}</PopoverState.Provider>
    },
    // Radix `asChild` renders the child itself and owns its click; mirror that.
    PopoverTrigger: ({ children }: { children: React.ReactElement }) => {
      const { open, onOpenChange } = useContext(PopoverState)
      return cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
        onClick: () => onOpenChange?.(!open)
      })
    },
    // Radix mounts content only while open — the property the lazy list relies on.
    PopoverContent: ({ children }: { children: React.ReactNode }) =>
      useContext(PopoverState).open ? <div>{children}</div> : null
  }
})

// The virtual window needs real layout the test DOM has none of; render every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 44,
        size: 44
      })),
    scrollToIndex: vi.fn(),
    scrollToOffset: vi.fn()
  })
}))

const { ComposerParentWorktreePicker } = await import('./ComposerParentWorktreePicker')

const REPO_ID = 'repo1'

function makeRepo(id: string): Repo {
  return {
    id,
    path: `/src/${id}`,
    displayName: id,
    badgeColor: '#111111',
    addedAt: 0
  } as Repo
}

function makeWorktree(overrides: Partial<Worktree> & { id: string }): Worktree {
  return {
    repoId: REPO_ID,
    path: `/work/${overrides.id}`,
    head: 'abc123',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: overrides.id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function seed(worktrees: Worktree[], repoIds: string[] = [REPO_ID]): void {
  const byRepo: Record<string, Worktree[]> = {}
  for (const worktree of worktrees) {
    byRepo[worktree.repoId] = [...(byRepo[worktree.repoId] ?? []), worktree]
  }
  storeState.worktreesByRepo = byRepo
  storeState.repos = repoIds.map(makeRepo)
}

function trigger(): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>('button[role="combobox"]')
  if (!node) {
    throw new Error('parent picker trigger not found')
  }
  return node
}

function rows(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'))
}

function candidateLabels(): string[] {
  return rows()
    .slice(1)
    .map((row) => row.textContent ?? '')
}

beforeEach(() => {
  storeState.worktreesByRepo = {}
  storeState.repos = []
  storeState.worktreeLineageById = {}
  storeState.workspaceLineageByChildKey = {}
})

afterEach(cleanup)

describe('ComposerParentWorktreePicker', () => {
  it('offers live folder descendants through retired roots and intermediate parents', () => {
    const attached = makeWorktree({
      id: 'attached',
      displayName: 'Attached',
      instanceId: 'attached-instance',
      removing: true,
      removalRecorded: true
    })
    const nested = makeWorktree({
      id: 'nested',
      displayName: 'Nested',
      instanceId: 'nested-instance'
    })
    const bridge = makeWorktree({
      id: 'bridge',
      instanceId: 'bridge-instance',
      removing: true,
      removalRecorded: true
    })
    const leaf = makeWorktree({ id: 'leaf', displayName: 'Leaf', instanceId: 'leaf-instance' })
    const outside = makeWorktree({ id: 'outside', displayName: 'Outside' })
    seed([attached, nested, bridge, leaf, outside])
    storeState.workspaceLineageByChildKey = {
      [worktreeWorkspaceKey(attached.id)]: {
        childWorkspaceKey: worktreeWorkspaceKey(attached.id),
        childInstanceId: attached.instanceId ?? null,
        parentWorkspaceKey: folderWorkspaceKey('folder-1'),
        parentInstanceId: null,
        origin: 'manual',
        capture: { source: 'active-workspace', confidence: 'explicit' },
        createdAt: 1
      }
    }
    storeState.worktreeLineageById = {
      [nested.id]: {
        worktreeId: nested.id,
        worktreeInstanceId: 'nested-instance',
        parentWorktreeId: attached.id,
        parentWorktreeInstanceId: 'attached-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 2
      },
      [bridge.id]: {
        worktreeId: bridge.id,
        worktreeInstanceId: 'bridge-instance',
        parentWorktreeId: nested.id,
        parentWorktreeInstanceId: 'nested-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 3
      },
      [leaf.id]: {
        worktreeId: leaf.id,
        worktreeInstanceId: 'leaf-instance',
        parentWorktreeId: bridge.id,
        parentWorktreeInstanceId: 'bridge-instance',
        origin: 'manual',
        capture: { source: 'manual-action', confidence: 'explicit' },
        createdAt: 4
      }
    }
    const onChange = vi.fn()
    render(
      <ComposerParentWorktreePicker
        repoId={REPO_ID}
        value={null}
        onChange={onChange}
        activeFolderWorkspaceId="folder-1"
      />
    )
    fireEvent.click(trigger())

    const labels = candidateLabels().join(' ')
    expect(labels).not.toContain('Attached')
    expect(labels).not.toContain('bridge')
    expect(labels).toContain('Nested')
    expect(labels).toContain('Leaf')
    expect(labels).not.toContain('Outside')
    fireEvent.click(rows().find((row) => row.textContent?.includes('Leaf'))!)
    expect(onChange).toHaveBeenCalledWith('leaf')
  })

  it('closes an open popover when the drawer collapses the trigger', () => {
    seed([makeWorktree({ id: 'alpha', displayName: 'Alpha' })])

    const view = render(
      <ComposerParentWorktreePicker repoId={REPO_ID} value={null} onChange={vi.fn()} />
    )
    fireEvent.click(trigger())
    expect(rows().length).toBeGreaterThan(0)

    view.rerender(
      <ComposerParentWorktreePicker repoId={REPO_ID} value={null} onChange={vi.fn()} disabled />
    )

    expect(rows()).toHaveLength(0)
  })
})
