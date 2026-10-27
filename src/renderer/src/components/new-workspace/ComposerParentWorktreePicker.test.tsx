// @vitest-environment happy-dom

import { act } from 'react'
import type React from 'react'
import { makeFolderWorkspace } from '../../store/slices/worktrees-slice-test-fixtures'
import { getLineageInputs } from '../sidebar/visible-worktree-indexes'
import type * as WorktreeRepoIndex from '../../../../shared/sidebar-list/worktree-lineage-projection'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { WorkspaceLineage, WorktreeLineage } from '../../../../shared/worktree/lineage-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { folderWorkspaceKey, worktreeWorkspaceKey } from '../../../../shared/workspace-scope'

type FakeStoreState = {
  folderWorkspaces?: FolderWorkspace[]
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

const popoverMock = vi.hoisted(() => ({
  open: false,
  onOpenChange: undefined as ((open: boolean) => void) | undefined
}))

const virtualKeys = vi.hoisted((): { current: (string | number)[] } => ({ current: [] }))

const indexSpies = vi.hoisted(() => ({ getWorktreeLineageProjection: vi.fn() }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback })
}))

const storeWrites = vi.hoisted(() => ({
  set: (_state: Partial<FakeStoreState>, _replace?: boolean) => {}
}))
vi.mock('@/store', async () => {
  const { createStore, useStore } = await import('zustand')
  const store = createStore(() => storeState)
  storeWrites.set = (state, replace) =>
    replace ? store.setState({ ...storeState, ...state }, true) : store.setState(state)
  return {
    useAppStore: (selector: (state: FakeStoreState) => unknown) =>
      useStore(store, () => selector(storeState))
  }
})

vi.mock('../../../../shared/sidebar-list/worktree-lineage-projection', async (importOriginal) => {
  const actual = await importOriginal<typeof WorktreeRepoIndex>()
  indexSpies.getWorktreeLineageProjection.mockImplementation(actual.getWorktreeLineageProjection)
  return { ...actual, ...indexSpies }
})

vi.mock('@/components/ui/popover', async () => {
  const { cloneElement } = await import('react')
  return {
    Popover: ({
      children,
      open,
      onOpenChange
    }: {
      children: React.ReactNode
      open?: boolean
      onOpenChange?: (open: boolean) => void
    }) => {
      popoverMock.open = open ?? false
      popoverMock.onOpenChange = onOpenChange
      return <div>{children}</div>
    },
    // Radix `asChild` renders the child itself and owns its click; mirror that.
    PopoverTrigger: ({ children }: { children: React.ReactElement }) =>
      cloneElement(children as React.ReactElement<{ onClick?: () => void }>, {
        onClick: () => popoverMock.onOpenChange?.(!popoverMock.open)
      }),
    // Radix mounts content only while open — the property the lazy list relies on.
    PopoverContent: ({ children }: { children: React.ReactNode }) =>
      popoverMock.open ? <div>{children}</div> : null
  }
})

// The virtual window needs real layout the test DOM has none of; render every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({
    count,
    getItemKey
  }: {
    count: number
    getItemKey: (index: number) => string | number
  }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: (virtualKeys.current[index] = getItemKey(index)),
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
  storeWrites.set(storeState, true)
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

function searchInput(): HTMLInputElement {
  const node = document.querySelector<HTMLInputElement>('[data-slot="command-input"]')
  if (!node) {
    throw new Error('parent picker search input not found')
  }
  return node
}

function rowFor(label: string): HTMLElement {
  const row = rows().find((node) => node.textContent?.includes(label))
  if (!row) {
    throw new Error(`row not found for ${label}`)
  }
  return row
}

beforeEach(() => {
  popoverMock.open = false
  popoverMock.onOpenChange = undefined
  storeState.worktreesByRepo = {}
  storeState.repos = []
  storeState.worktreeLineageById = {}
  storeState.workspaceLineageByChildKey = {}
  storeState.folderWorkspaces = []
  indexSpies.getWorktreeLineageProjection.mockClear()
  storeWrites.set(storeState, true)
})

afterEach(cleanup)

describe('ComposerParentWorktreePicker', () => {
  it('enumerates candidate worktrees only once the popover opens', () => {
    seed([makeWorktree({ id: 'alpha' }), makeWorktree({ id: 'beta' })])

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value="alpha" onChange={vi.fn()} />)

    expect(indexSpies.getWorktreeLineageProjection).not.toHaveBeenCalled()
    fireEvent.click(trigger())
    expect(indexSpies.getWorktreeLineageProjection).toHaveBeenCalledOnce()
  })

  it('shows "No parent" on the closed trigger when nothing is picked', () => {
    seed([makeWorktree({ id: 'alpha' })])

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value={null} onChange={vi.fn()} />)

    expect(trigger().textContent).toContain('No parent')
  })

  it('shows the picked worktree display name on the closed trigger', () => {
    seed([makeWorktree({ id: 'alpha', displayName: 'Alpha workspace' })])

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value="alpha" onChange={vi.fn()} />)

    expect(trigger().textContent).toContain('Alpha workspace')
    expect(trigger().textContent).not.toContain('No parent')
  })

  it('reports the picked worktree id and closes when a candidate row is clicked', () => {
    const onChange = vi.fn()
    seed([makeWorktree({ id: 'alpha', displayName: 'Alpha' })])

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value={null} onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.click(rowFor('Alpha'))

    expect(onChange).toHaveBeenCalledWith(JSON.stringify(['', null, 'alpha', null]))
    expect(rows()).toHaveLength(0)
  })

  it('clears the pick when the pinned "No parent" row is clicked', () => {
    const onChange = vi.fn()
    seed([makeWorktree({ id: 'alpha', displayName: 'Alpha' })])

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value="alpha" onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.click(rows()[0])

    expect(onChange).toHaveBeenCalledWith(null)
    expect(rows()).toHaveLength(0)
  })

  it('offers parents from another repo while excluding archived worktrees', () => {
    seed(
      [
        makeWorktree({ id: 'alpha', displayName: 'Alpha' }),
        makeWorktree({ id: 'archived', displayName: 'Archived', isArchived: true }),
        makeWorktree({ id: 'other', displayName: 'Other repo', repoId: 'repo2' })
      ],
      [REPO_ID, 'repo2']
    )

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value={null} onChange={vi.fn()} />)
    fireEvent.click(trigger())

    expect(candidateLabels().join(' ')).toContain('Alpha')
    expect(candidateLabels().join(' ')).not.toContain('Archived')
    expect(candidateLabels().join(' ')).toContain('Other repo')
  })

  it('offers parents in another project and on another host', () => {
    seed([
      makeWorktree({ id: 'same', displayName: 'Same host', hostId: 'local', projectId: 'proj1' }),
      makeWorktree({
        id: 'otherHost',
        displayName: 'Other host',
        hostId: 'ssh:box',
        projectId: 'proj1'
      }),
      makeWorktree({
        id: 'otherProject',
        displayName: 'Other project',
        hostId: 'local',
        projectId: 'proj2'
      })
    ])

    render(
      <ComposerParentWorktreePicker
        repoId={REPO_ID}
        executionHostId="local"
        projectId="proj1"
        value={null}
        onChange={vi.fn()}
      />
    )
    fireEvent.click(trigger())

    expect(candidateLabels().join(' ')).toContain('Same host')
    expect(candidateLabels().join(' ')).toContain('Other host')
    expect(candidateLabels().join(' ')).toContain('Other project')
  })

  it('keeps candidates whose host or project is unrecorded', () => {
    seed([makeWorktree({ id: 'unscoped', displayName: 'Unscoped' })])

    render(
      <ComposerParentWorktreePicker
        repoId={REPO_ID}
        executionHostId="local"
        projectId="proj1"
        value={null}
        onChange={vi.fn()}
      />
    )
    fireEvent.click(trigger())

    expect(candidateLabels().join(' ')).toContain('Unscoped')
  })

  it('restricts candidates to the active folder workspace subtree', () => {
    const attached = makeWorktree({
      id: 'attached',
      displayName: 'Attached',
      instanceId: 'attached-instance'
    })
    const nested = makeWorktree({
      id: 'nested',
      displayName: 'Nested',
      instanceId: 'nested-instance'
    })
    const outside = makeWorktree({ id: 'outside', displayName: 'Outside' })
    seed([attached, nested, outside])
    storeState.folderWorkspaces = [makeFolderWorkspace({ name: 'Folder', folderPath: '/folder' })]
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
      }
    }

    render(
      <ComposerParentWorktreePicker
        repoId={REPO_ID}
        value={null}
        onChange={vi.fn()}
        activeFolderWorkspaceId="folder-1"
      />
    )
    fireEvent.click(trigger())

    const labels = candidateLabels().join(' ')
    expect(labels).toContain('Attached')
    expect(labels).toContain('Nested')
    expect(labels).not.toContain('Outside')
  })

  it('keeps the trigger inert while disabled', () => {
    seed([makeWorktree({ id: 'alpha', displayName: 'Alpha' })])

    render(
      <ComposerParentWorktreePicker repoId={REPO_ID} value={null} onChange={vi.fn()} disabled />
    )
    fireEvent.click(trigger())

    expect(trigger().disabled).toBe(true)
    expect(rows()).toHaveLength(0)
  })

  it('picks the top match when Enter follows a search query', () => {
    const onChange = vi.fn()
    seed([
      makeWorktree({ id: 'alpha', displayName: 'Alpha' }),
      makeWorktree({ id: 'beta', displayName: 'Beta' })
    ])

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value={null} onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.change(searchInput(), { target: { value: 'Beta' } })
    fireEvent.keyDown(searchInput(), { key: 'Enter', keyCode: 13 })

    // Typing/Enter must pick the top match instead of clearing via No parent.
    expect(onChange).toHaveBeenCalledWith(JSON.stringify(['', null, 'beta', null]))
  })

  it('clears the parent when Enter is pressed with no search query', () => {
    const onChange = vi.fn()
    seed([makeWorktree({ id: 'alpha', displayName: 'Alpha' })])

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value="alpha" onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.keyDown(searchInput(), { key: 'Enter', keyCode: 13 })

    expect(onChange).toHaveBeenCalledWith(null)
  })

  it('keeps the parent when Enter only confirms a CJK composition', () => {
    const onChange = vi.fn()
    seed([makeWorktree({ id: 'alpha', displayName: 'Alpha' })])

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value={null} onChange={onChange} />)
    fireEvent.click(trigger())
    fireEvent.compositionStart(searchInput())
    // The confirming Enter arrives twice: the marked keydown, then an unmarked redispatch.
    fireEvent.keyDown(searchInput(), { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(searchInput(), { key: 'Enter', keyCode: 13 })

    expect(onChange).not.toHaveBeenCalled()
    expect(rows().length).toBeGreaterThan(0)
  })

  it('falls back to "No parent" on the trigger when the picked parent is archived', () => {
    seed([makeWorktree({ id: 'alpha', displayName: 'Alpha workspace', isArchived: true })])

    render(<ComposerParentWorktreePicker repoId={REPO_ID} value="alpha" onChange={vi.fn()} />)

    expect(trigger().textContent).not.toContain('Alpha workspace')
    expect(trigger().textContent).toContain('No parent')
  })

  it('excludes a folder root whose lineage row is instance-stale', () => {
    const attached = makeWorktree({
      id: 'attached',
      displayName: 'Attached',
      instanceId: 'current-instance'
    })
    seed([attached])
    storeState.folderWorkspaces = [makeFolderWorkspace({ name: 'Folder', folderPath: '/folder' })]
    storeState.workspaceLineageByChildKey = {
      [worktreeWorkspaceKey(attached.id)]: {
        childWorkspaceKey: worktreeWorkspaceKey(attached.id),
        childInstanceId: 'deleted-and-recreated',
        parentWorkspaceKey: folderWorkspaceKey('folder-1'),
        parentInstanceId: null,
        origin: 'manual',
        capture: { source: 'active-workspace', confidence: 'explicit' },
        createdAt: 1
      }
    }

    render(
      <ComposerParentWorktreePicker
        repoId={REPO_ID}
        value={null}
        onChange={vi.fn()}
        activeFolderWorkspaceId="folder-1"
      />
    )
    fireEvent.click(trigger())

    expect(candidateLabels().join(' ')).not.toContain('Attached')
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

it('opens both same-host store copies with distinct keys and selects the exact searched copy', () => {
  const a = makeWorktree({
    id: 'parent',
    instanceId: 'copy',
    hostId: 'ssh:shared',
    runtimeOwnerEnvironmentId: 'A',
    displayName: 'Alpha'
  })
  const b = { ...a, runtimeOwnerEnvironmentId: 'B', displayName: 'Beta' }
  seed([a, b])
  const change = vi.fn()
  render(<ComposerParentWorktreePicker repoId={REPO_ID} value={null} onChange={change} />)
  fireEvent.click(trigger())
  expect(virtualKeys.current.slice(1, 3)).toEqual([
    JSON.stringify(['A', 'ssh:shared', 'parent', 'copy']),
    JSON.stringify(['B', 'ssh:shared', 'parent', 'copy'])
  ])
  expect(new Set(virtualKeys.current.slice(0, 3)).size).toBe(3)
  fireEvent.change(searchInput(), { target: { value: 'Beta' } })
  fireEvent.click(rowFor('Beta'))
  expect(change).toHaveBeenCalledWith(JSON.stringify(['B', 'ssh:shared', 'parent', 'copy']))
})

it.each([10, 100])(
  'does not traverse warm closed picker rows on an unrelated store write at N=%i',
  (n) => {
    let traversed = 0
    const items = Array.from({ length: n }, (_, i) => makeWorktree({ id: `row-${i}` }))
    seed(items)
    const heldRows = getLineageInputs(storeState).worktreeMap
    const change = vi.fn()
    const { rerender } = render(
      <ComposerParentWorktreePicker repoId={REPO_ID} value="row-0" onChange={change} />
    )
    expect(trigger().textContent).toContain('row-0')
    const nativeValues = heldRows.values
    const observedValues = vi.spyOn(heldRows, 'values').mockImplementation(function (
      this: Map<string, Worktree>
    ) {
      const iterator = nativeValues.call(this)
      const next = iterator.next.bind(iterator)
      iterator.next = () => {
        const entry = next()
        if (!entry.done) {
          traversed++
        }
        return entry
      }
      return iterator
    })
    try {
      expect([...heldRows.values()]).toEqual(items)
      expect(traversed).toBe(n)
      traversed = 0
      act(() => {
        storeState.projectHostSetups = []
        storeWrites.set({ projectHostSetups: [] })
      })
      rerender(
        <ComposerParentWorktreePicker repoId={REPO_ID} value="row-0" onChange={change} disabled />
      )
      expect(getLineageInputs(storeState).worktreeMap).toBe(heldRows)
      expect(traversed).toBe(0)
      storeState.worktreesByRepo = {
        [REPO_ID]: [{ ...items[0]!, displayName: 'Renamed' }, ...items.slice(1)]
      }
      rerender(<ComposerParentWorktreePicker repoId={REPO_ID} value="row-0" onChange={change} />)
      expect(trigger().textContent).toContain('Renamed')
    } finally {
      observedValues.mockRestore()
    }
  }
)
