// @vitest-environment happy-dom

import { act, type ReactNode, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitHistoryItem, GitHistoryResult } from '../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../shared/types'
import { GitHistoryPanel, type GitHistoryPanelState } from './GitHistoryPanel'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={() => onSelect?.()}>
      {children}
    </button>
  )
}))

const timestamp = new Date(2026, 5, 15, 12).getTime()

function makeHistoryItem(overrides: Partial<GitHistoryItem> = {}): GitHistoryItem {
  return {
    id: '52ad492abcd',
    parentIds: [],
    subject: 'Fix tab overflow',
    message: 'Fix tab overflow',
    displayId: '52ad492',
    author: 'Taylor',
    timestamp,
    references: [],
    ...overrides
  }
}

function makeHistoryResult(items: GitHistoryItem[] = [makeHistoryItem()]): GitHistoryResult {
  return {
    items,
    currentRef: {
      id: 'refs/heads/main',
      name: 'main',
      revision: items[0]?.id ?? '52ad492abcd',
      category: 'branches'
    },
    hasIncomingChanges: false,
    hasOutgoingChanges: false,
    hasMore: false,
    limit: 50
  }
}

const DEFAULT_PANEL_STATE: GitHistoryPanelState = {
  status: 'ready',
  result: makeHistoryResult()
}

function makeEntry(overrides: Partial<GitBranchChangeEntry>): GitBranchChangeEntry {
  return {
    path: 'src/file.ts',
    status: 'modified',
    added: 1,
    removed: 0,
    ...overrides
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

type RenderPanelOptions = {
  state?: GitHistoryPanelState
  initialCommitFilesViewMode?: 'list' | 'tree'
  onRefresh?: () => void | Promise<void>
  onLoadCommitFiles?: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
  onOpenCommitFile?: (
    item: GitHistoryItem,
    entry: GitBranchChangeEntry,
    event?: {
      altKey: boolean
      ctrlKey: boolean
      metaKey: boolean
      shiftKey: boolean
      openAsPermanent?: boolean
    }
  ) => void
}

function PanelHarness({
  state = DEFAULT_PANEL_STATE,
  initialCommitFilesViewMode = 'list',
  onRefresh = vi.fn(),
  onLoadCommitFiles,
  onOpenCommitFile
}: RenderPanelOptions): ReactNode {
  const [commitFilesViewMode, setCommitFilesViewMode] = useState(initialCommitFilesViewMode)

  return (
    <GitHistoryPanel
      state={state}
      collapsed={false}
      commitFilesViewMode={commitFilesViewMode}
      onCommitFilesViewModeChange={setCommitFilesViewMode}
      onToggle={vi.fn()}
      onRefresh={onRefresh}
      onOpenCommit={vi.fn()}
      onLoadCommitFiles={onLoadCommitFiles}
      onOpenCommitFile={onOpenCommitFile}
    />
  )
}

function renderPanel(options: RenderPanelOptions = {}): void {
  act(() => {
    root.render(<PanelHarness {...options} />)
  })
}

function commitRow(item: GitHistoryItem): HTMLButtonElement {
  const row = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-testid="git-history-row"]')
  ).find((element) =>
    element.getAttribute('aria-label')?.includes(`commit ${item.displayId ?? item.id}:`)
  )
  if (!row) {
    throw new Error(`Missing history row for ${item.id}`)
  }
  return row
}

type CommitFilesScope = {
  commitId: string
  readonly textContent: string
}

function commitFiles(item: GitHistoryItem): CommitFilesScope {
  const selector = `[data-history-commit-detail][data-commit-id="${item.id}"]`
  if (!container.querySelector(selector)) {
    throw new Error(`Missing files for ${item.id}`)
  }
  return {
    commitId: item.id,
    get textContent() {
      return Array.from(container.querySelectorAll<HTMLElement>(selector))
        .map((element) => element.textContent)
        .join('')
    }
  }
}

function fileRows(element: ParentNode | CommitFilesScope): HTMLButtonElement[] {
  const rows = Array.from(
    container.querySelectorAll<HTMLButtonElement>('[data-testid="git-history-commit-file"]')
  )
  return 'commitId' in element
    ? rows.filter((row) => row.dataset.commitId === element.commitId)
    : Array.from(
        element.querySelectorAll<HTMLButtonElement>('[data-testid="git-history-commit-file"]')
      )
}

function directoryRows(element: ParentNode | CommitFilesScope): HTMLElement[] {
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-testid="git-history-commit-directory"]')
  )
  return 'commitId' in element
    ? rows.filter((row) => row.dataset.commitId === element.commitId)
    : Array.from(
        element.querySelectorAll<HTMLElement>('[data-testid="git-history-commit-directory"]')
      )
}

function findCommitFilesViewAction(
  label: 'View as list' | 'View as tree'
): HTMLButtonElement | null {
  return (
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === label
    ) ?? null
  )
}

function commitFilesViewAction(label: 'View as list' | 'View as tree'): HTMLButtonElement {
  const action = findCommitFilesViewAction(label)
  if (!action) {
    throw new Error(`Missing commit-files view action: ${label}`)
  }
  return action
}

function commitFilesViewActionCount(): number {
  return ['View as list', 'View as tree'].filter(
    (label) => findCommitFilesViewAction(label as 'View as list' | 'View as tree') !== null
  ).length
}

function selectCommitFilesView(label: 'View as list' | 'View as tree'): void {
  const action = commitFilesViewAction(label)
  act(() => {
    action.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// Flush only loader microtasks; stale-load tests must leave unresolved loaders pending.
async function expandCommit(item: GitHistoryItem): Promise<void> {
  const row = commitRow(item)
  await act(async () => {
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('GitHistoryPanel', () => {
  it.each([Number.NaN, Number.MAX_VALUE])(
    'renders commits with malformed timestamp %s without crashing',
    (malformedTimestamp) => {
      const item = makeHistoryItem({ timestamp: malformedTimestamp })

      renderPanel({ state: { status: 'ready', result: makeHistoryResult([item]) } })

      expect(container.textContent).toContain('Fix tab overflow')
    }
  )

  it('renders the commit subject row', () => {
    renderPanel()

    expect(container.textContent).toContain('Fix tab overflow')
    expect(commitRow(makeHistoryItem()).getAttribute('aria-label')).toContain('52ad492')
  })

  it('shows a retryable alert above a retained graph when refresh fails', () => {
    const item = makeHistoryItem()
    const onRefresh = vi.fn()

    renderPanel({
      state: { status: 'error', result: makeHistoryResult([item]), error: 'Refresh failed' },
      onRefresh
    })

    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.getAttribute('aria-atomic')).toBe('true')
    expect(alert?.textContent).toContain('Refresh failed')
    expect(commitRow(item)).not.toBeNull()
    const retry = Array.from(alert?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    if (!retry) {
      throw new Error('Missing history refresh retry')
    }
    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it('shows the same retry surface when the initial history load fails', () => {
    const onRefresh = vi.fn()

    renderPanel({ state: { status: 'error', error: 'Initial load failed' }, onRefresh })

    const alert = container.querySelector<HTMLElement>('[role="alert"]')
    expect(alert?.textContent).toContain('Initial load failed')
    expect(container.querySelector('[data-testid="git-history-row"]')).toBeNull()
    const retry = Array.from(alert?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Retry'
    )
    if (!retry) {
      throw new Error('Missing initial history retry')
    }
    act(() => {
      retry.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onRefresh).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['header refresh', DEFAULT_PANEL_STATE, 'Refresh commits', false],
    [
      'inline retry',
      { status: 'error' as const, result: makeHistoryResult(), error: 'Refresh failed' },
      'Retry',
      true
    ]
  ])(
    'guards duplicate %s clicks before the parent rerenders',
    async (_name, state, label, nativeDisabled) => {
      let resolveRefresh: (() => void) | undefined
      const refreshPromise = new Promise<void>((resolve) => {
        resolveRefresh = resolve
      })
      const onRefresh = vi.fn().mockReturnValueOnce(refreshPromise).mockResolvedValue(undefined)

      renderPanel({ state, onRefresh })
      const refresh = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) =>
          button.getAttribute('aria-label') === label || button.textContent?.trim() === label
      )
      if (!refresh) {
        throw new Error(`Missing history ${label} button`)
      }
      act(() => {
        refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onRefresh).toHaveBeenCalledTimes(1)
      expect(refresh.getAttribute('aria-disabled')).toBe(nativeDisabled ? null : 'true')
      expect(refresh.disabled).toBe(nativeDisabled)

      const settleRefresh = resolveRefresh
      if (!settleRefresh) {
        throw new Error('Missing history refresh resolver')
      }
      await act(async () => {
        settleRefresh()
        await refreshPromise
        await Promise.resolve()
      })
      expect(refresh.getAttribute('aria-disabled')).not.toBe('true')
      expect(refresh.disabled).toBe(false)

      act(() => {
        refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onRefresh).toHaveBeenCalledTimes(2)
    }
  )

  it.each([
    ['loading', { status: 'loading' as const }],
    ['refreshing', { status: 'refreshing' as const, result: makeHistoryResult() }]
  ])('keeps the refresh control focusable but inert while %s', (_name, state) => {
    const onRefresh = vi.fn()

    renderPanel({ state, onRefresh })
    const refresh = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Refresh commits"]'
    )
    if (!refresh) {
      throw new Error('Missing history refresh button')
    }
    refresh.focus()
    act(() => {
      refresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(document.activeElement).toBe(refresh)
    expect(refresh.getAttribute('aria-disabled')).toBe('true')
    expect(refresh.disabled).toBe(false)
    expect(onRefresh).not.toHaveBeenCalled()
  })

  it('defaults to flat commit changes and switches between list and tree without reloading', async () => {
    const item = makeHistoryItem()
    const entries = [
      makeEntry({ path: 'src/components/Tab.tsx' }),
      makeEntry({ path: 'docs/overview.md', status: 'added' })
    ]
    const onLoadCommitFiles = vi.fn().mockResolvedValue(entries)

    renderPanel({
      state: { status: 'ready', result: makeHistoryResult([item]) },
      onLoadCommitFiles,
      onOpenCommitFile: vi.fn()
    })
    await expandCommit(item)
    expect(findCommitFilesViewAction('View as tree')).not.toBeNull()
    expect(findCommitFilesViewAction('View as list')).toBeNull()
    expect(commitFilesViewActionCount()).toBe(1)

    const files = commitFiles(item)
    expect(fileRows(files)).toHaveLength(entries.length)
    expect(directoryRows(files)).toHaveLength(0)
    expect(files.textContent).toContain('src/components')
    expect(files.textContent).toContain('docs')
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)

    selectCommitFilesView('View as tree')
    expect(findCommitFilesViewAction('View as tree')).toBeNull()
    expect(findCommitFilesViewAction('View as list')).not.toBeNull()
    expect(commitFilesViewActionCount()).toBe(1)

    expect(directoryRows(files).map((directory) => directory.dataset.treePath)).toEqual(
      expect.arrayContaining(['src/components', 'docs'])
    )
    expect(fileRows(files)).toHaveLength(entries.length)
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)

    selectCommitFilesView('View as list')
    expect(findCommitFilesViewAction('View as list')).toBeNull()
    expect(findCommitFilesViewAction('View as tree')).not.toBeNull()
    expect(commitFilesViewActionCount()).toBe(1)

    expect(fileRows(files)).toHaveLength(entries.length)
    expect(directoryRows(files)).toHaveLength(0)
    expect(files.textContent).toContain('src/components')
    expect(files.textContent).toContain('docs')
  })

  it('exposes the full commit file path through a tooltip instead of a native title', async () => {
    const item = makeHistoryItem()
    const entry = makeEntry({ path: 'src/components/deep/TooltipTarget.tsx' })

    renderPanel({
      state: { status: 'ready', result: makeHistoryResult([item]) },
      onLoadCommitFiles: vi.fn().mockResolvedValue([entry]),
      onOpenCommitFile: vi.fn()
    })
    await expandCommit(item)

    const file = fileRows(commitFiles(item))[0]
    expect(file?.hasAttribute('title')).toBe(false)
    expect(container.textContent).toContain(entry.path)
  })

  it('uses the full highlighted directory row as the collapse control', async () => {
    const item = makeHistoryItem()
    const entries = [
      makeEntry({ path: 'src/shared/one.ts' }),
      makeEntry({ path: 'src/shared/two.ts' })
    ]

    renderPanel({
      state: { status: 'ready', result: makeHistoryResult([item]) },
      initialCommitFilesViewMode: 'tree',
      onLoadCommitFiles: vi.fn().mockResolvedValue(entries),
      onOpenCommitFile: vi.fn()
    })
    await expandCommit(item)

    const directory = directoryRows(commitFiles(item))[0]
    expect(directory?.tagName).toBe('BUTTON')
    expect(directory?.getAttribute('aria-expanded')).toBe('true')
    act(() => {
      directory?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(directory?.getAttribute('aria-expanded')).toBe('false')
    expect(fileRows(commitFiles(item))).toHaveLength(0)
  })

  it('resets expansion, cache, and directory state when the history result identity changes', async () => {
    const item = makeHistoryItem()
    const entries = [
      makeEntry({ path: 'packages/app/src/index.ts' }),
      makeEntry({ path: 'packages/app/package.json', status: 'added' }),
      makeEntry({ path: 'packages/server/src/main.ts' })
    ]
    const onLoadCommitFiles = vi.fn().mockResolvedValue(entries)
    const state = { status: 'ready' as const, result: makeHistoryResult([item]) }

    renderPanel({
      state,
      onLoadCommitFiles,
      onOpenCommitFile: vi.fn()
    })
    selectCommitFilesView('View as tree')
    await expandCommit(item)

    expect(directoryRows(commitFiles(item))).toHaveLength(4)
    const collapsedDirectory = directoryRows(commitFiles(item)).find(
      (directory) => directory.dataset.treePath === 'packages/app'
    )
    const collapsedDirectoryToggle = collapsedDirectory
    if (!collapsedDirectoryToggle) {
      throw new Error('Missing packages/app directory toggle')
    }
    act(() => {
      collapsedDirectoryToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(fileRows(commitFiles(item)).length).toBeLessThan(entries.length)

    renderPanel({
      state: { status: 'ready', result: makeHistoryResult([item]) },
      onLoadCommitFiles,
      onOpenCommitFile: vi.fn()
    })
    expect(container.querySelector('[data-testid="git-history-commit-files"]')).toBeNull()
    await expandCommit(item)

    expect(onLoadCommitFiles).toHaveBeenCalledTimes(2)
    expect(directoryRows(commitFiles(item))).toHaveLength(4)
    expect(fileRows(commitFiles(item))).toHaveLength(entries.length)
    expect(
      directoryRows(commitFiles(item))
        .find((directory) => directory.dataset.treePath === 'packages/app')
        ?.getAttribute('aria-expanded')
    ).toBe('true')
  })

  it('routes a tree file click to its matching commit, entry, and row event', async () => {
    const first = makeHistoryItem({
      id: 'first-commit',
      displayId: 'first',
      subject: 'First commit'
    })
    const second = makeHistoryItem({
      id: 'second-commit',
      displayId: 'second',
      subject: 'Second commit'
    })
    const firstEntry = makeEntry({ path: 'src/first.ts' })
    const secondEntry = makeEntry({ path: 'src/components/Second.tsx' })
    const onOpenCommitFile = vi.fn()
    const onLoadCommitFiles = vi.fn((item: GitHistoryItem) =>
      Promise.resolve(item.id === second.id ? [secondEntry] : [firstEntry])
    )

    renderPanel({
      state: { status: 'ready', result: makeHistoryResult([first, second]) },
      onLoadCommitFiles,
      onOpenCommitFile
    })
    selectCommitFilesView('View as tree')
    await expandCommit(first)
    await expandCommit(second)

    const file = fileRows(commitFiles(second)).find(
      (element) => element.dataset.filePath === secondEntry.path
    )
    if (!file) {
      throw new Error(`Missing file row for ${secondEntry.path}`)
    }
    act(() => {
      file.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    })

    expect(onOpenCommitFile).toHaveBeenCalledTimes(1)
    const [openedItem, openedEntry, rowEvent] = onOpenCommitFile.mock.calls[0] ?? []
    expect(openedItem).toStrictEqual(second)
    expect(openedItem).toMatchObject({ id: second.id })
    expect(openedEntry).toBe(secondEntry)
    expect(rowEvent).toEqual({
      altKey: false,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false
    })
  })

  it('preserves expanded files and directory state while a retained result refreshes or errors', async () => {
    const item = makeHistoryItem()
    const result = makeHistoryResult([item])
    const entries = [
      makeEntry({ path: 'src/shared/one.ts' }),
      makeEntry({ path: 'src/shared/two.ts' })
    ]
    const onLoadCommitFiles = vi.fn().mockResolvedValue(entries)

    renderPanel({
      state: { status: 'ready', result },
      onLoadCommitFiles,
      onOpenCommitFile: vi.fn()
    })
    selectCommitFilesView('View as tree')
    await expandCommit(item)
    const directoryToggle = directoryRows(commitFiles(item))[0]
    if (!directoryToggle) {
      throw new Error('Missing commit directory toggle')
    }
    act(() => {
      directoryToggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(fileRows(commitFiles(item))).toHaveLength(0)

    for (const state of [
      { status: 'refreshing' as const, result },
      { status: 'error' as const, result, error: 'Refresh failed' }
    ]) {
      renderPanel({ state, onLoadCommitFiles, onOpenCommitFile: vi.fn() })

      expect(fileRows(commitFiles(item))).toHaveLength(0)
      expect(directoryRows(commitFiles(item))[0]?.getAttribute('aria-expanded')).toBe('false')
      expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)
    }
  })

  it.each(['resolve', 'reject'] as const)(
    'ignores a stale commit-file %s after replacing the history result',
    async (outcome) => {
      const item = makeHistoryItem()
      const staleEntry = makeEntry({ path: 'src/stale.ts' })
      const currentEntry = makeEntry({ path: 'src/current.ts' })
      let settleStaleLoad: (() => void) | undefined
      const staleLoad = new Promise<GitBranchChangeEntry[]>((resolve, reject) => {
        settleStaleLoad =
          outcome === 'resolve' ? () => resolve([staleEntry]) : () => reject(new Error('stale'))
      })
      const onLoadCommitFiles = vi
        .fn()
        .mockReturnValueOnce(staleLoad)
        .mockResolvedValueOnce([currentEntry])

      renderPanel({
        state: { status: 'ready', result: makeHistoryResult([item]) },
        onLoadCommitFiles,
        onOpenCommitFile: vi.fn()
      })
      await expandCommit(item)
      expect(commitFiles(item).textContent).toContain('Loading files')

      renderPanel({
        state: { status: 'ready', result: makeHistoryResult([item]) },
        onLoadCommitFiles,
        onOpenCommitFile: vi.fn()
      })
      await expandCommit(item)
      expect(commitFiles(item).textContent).toContain('current.ts')

      const settleLoader = settleStaleLoad
      if (!settleLoader) {
        throw new Error('Missing stale commit-file loader')
      }
      await act(async () => {
        settleLoader()
        await Promise.resolve()
      })

      expect(onLoadCommitFiles).toHaveBeenCalledTimes(2)
      expect(commitFiles(item).textContent).toContain('current.ts')
      expect(commitFiles(item).textContent).not.toContain('stale.ts')
      expect(commitFiles(item).textContent).not.toContain('stale')
    }
  )

  it('keeps same-path directory collapse state isolated between expanded commits', async () => {
    const first = makeHistoryItem({
      id: 'first-commit',
      displayId: 'first',
      subject: 'First commit'
    })
    const second = makeHistoryItem({
      id: 'second-commit',
      displayId: 'second',
      subject: 'Second commit'
    })
    const entries = [
      makeEntry({ path: 'src/shared/one.ts' }),
      makeEntry({ path: 'src/shared/two.ts' })
    ]
    const onLoadCommitFiles = vi.fn().mockResolvedValue(entries)

    renderPanel({
      state: { status: 'ready', result: makeHistoryResult([first, second]) },
      onLoadCommitFiles,
      onOpenCommitFile: vi.fn()
    })
    selectCommitFilesView('View as tree')
    await expandCommit(first)
    await expandCommit(second)

    const firstFiles = commitFiles(first)
    const secondFiles = commitFiles(second)
    const firstDirectory = directoryRows(firstFiles)[0]
    const secondDirectory = directoryRows(secondFiles)[0]
    if (!firstDirectory || !secondDirectory) {
      throw new Error('Missing shared source directory')
    }
    expect(firstDirectory.dataset.treePath).toBe(secondDirectory.dataset.treePath)
    expect(fileRows(firstFiles)).toHaveLength(entries.length)
    expect(fileRows(secondFiles)).toHaveLength(entries.length)

    const toggle = firstDirectory
    if (!toggle) {
      throw new Error('Missing directory toggle')
    }
    act(() => {
      toggle.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })

    expect(fileRows(firstFiles)).toHaveLength(0)
    expect(fileRows(secondFiles)).toHaveLength(entries.length)
  })

  it('keeps directory collapse state when a commit row is collapsed and re-expanded', async () => {
    const item = makeHistoryItem()
    const entries = [
      makeEntry({ path: 'src/shared/one.ts' }),
      makeEntry({ path: 'src/shared/two.ts' })
    ]
    const onLoadCommitFiles = vi.fn().mockResolvedValue(entries)

    renderPanel({
      state: { status: 'ready', result: makeHistoryResult([item]) },
      onLoadCommitFiles,
      onOpenCommitFile: vi.fn()
    })
    selectCommitFilesView('View as tree')
    await expandCommit(item)

    const directory = directoryRows(commitFiles(item))[0]
    if (!directory) {
      throw new Error('Missing shared source directory')
    }
    act(() => {
      directory.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(fileRows(commitFiles(item))).toHaveLength(0)

    await expandCommit(item)
    expect(container.querySelector('[data-history-commit-detail]')).toBeNull()

    await expandCommit(item)
    expect(onLoadCommitFiles).toHaveBeenCalledTimes(1)
    expect(fileRows(commitFiles(item))).toHaveLength(0)
    expect(directoryRows(commitFiles(item))[0]?.getAttribute('aria-expanded')).toBe('false')
  })

  // Why: this persisted preference applies to future commits, so empty history
  // must match the enabled changes-header action.
  it('keeps the commit-files view action enabled when there are no commits', () => {
    renderPanel({ state: { status: 'ready', result: makeHistoryResult([]) } })

    expect(commitFilesViewAction('View as tree').disabled).toBe(false)
  })
})
