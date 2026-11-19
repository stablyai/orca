// @vitest-environment happy-dom
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { GitHistoryResult } from '../../../../../../shared/git/history/git-history-types'
import type { GitBranchCompareSummary } from '../../../../../../shared/git/diff/git-diff-compare-types'

vi.mock('@/i18n/i18n', () => ({
  getIntlLocale: () => 'en-US',
  translate: (_key: string, fallback: string, values?: Record<string, unknown>) => {
    const template =
      values?.count === 1 && typeof values.defaultValue_one === 'string'
        ? values.defaultValue_one
        : fallback
    return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(values?.[name] ?? ''))
  }
}))
vi.mock('../sync/git-graph-open-button', () => ({ useGitGraphSupport: () => true }))
vi.mock('@/lib/source-control/graph/git-graph-tab', () => ({ openGitGraph: vi.fn() }))

import { SourceControlChangeScopeBar } from './change-scope-bar'
import { ALL_CHANGES_SCOPE, type SourceControlChangeScope } from './change-scope'
import type { SourceControlPanelReadyProps } from './panel-props'
import type { GitHistoryPanelState } from '../sync/use-git-history'

const COMMIT = {
  id: '191266b0000000000000000000000000000000000',
  displayId: '191266b',
  parentIds: [],
  subject: 'Retire PR recovery epochs',
  message: 'Retire PR recovery epochs',
  author: 'Jinjing',
  timestamp: 1_763_000_000_000
}

const PAGE: GitHistoryResult = {
  items: [COMMIT],
  currentRef: { id: 'refs/heads/feature', name: 'feature', revision: 'h1' },
  branch: {
    baseRef: { id: 'refs/remotes/origin/main', name: 'origin/main', revision: 'b1' },
    ahead: 1,
    behind: 0,
    unpushed: 1
  },
  hasIncomingChanges: false,
  hasOutgoingChanges: false,
  hasMore: false,
  limit: 50
}

const READY: GitBranchCompareSummary = {
  baseRef: 'origin/main',
  baseOid: 'b1',
  compareRef: 'feature',
  headOid: 'h1',
  mergeBase: 'm1',
  changedFiles: 1,
  commitsAhead: 1,
  status: 'ready'
}

afterEach(cleanup)

function renderBar({
  summary = READY,
  history = { status: 'ready', result: PAGE },
  initialScope = ALL_CHANGES_SCOPE
}: {
  summary?: GitBranchCompareSummary | null
  history?: GitHistoryPanelState
  initialScope?: SourceControlChangeScope
} = {}) {
  const calls = {
    openAllDiffs: vi.fn(),
    openHistoryCommitDiff: vi.fn(async () => {}),
    refreshGitHistory: vi.fn(async () => {})
  }
  function Harness() {
    const [changeScope, setChangeScope] = useState(initialScope)
    const [menuOpen, setMenuOpen] = useState(false)
    const model = {
      branchEntries: [{ path: 'b.ts', status: 'modified', added: 4, removed: 1 }],
      branchLineTotal: null,
      branchSummary: summary,
      changeScope,
      changeScopeMenuOpen: menuOpen,
      commitScopeFiles:
        changeScope.kind === 'commit'
          ? {
              commitId: changeScope.commit.id,
              status: 'ready',
              entries: [{ path: 'c.ts', status: 'modified', added: 2, removed: 0 }]
            }
          : null,
      compareBaseRef: 'origin/main',
      entries: [{ path: 'a.ts', status: 'modified', area: 'unstaged', added: 1, removed: 1 }],
      gitHistoryState: history,
      resolveSplitTargetGroupId: () => undefined,
      setBaseRefDialogOpen: vi.fn(),
      setChangeScope,
      setChangeScopeMenuOpen: setMenuOpen,
      ...calls
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the bar reads only the fields above.
    const props = {
      currentWorktreeId: 'wt-1',
      worktreePath: '/repo',
      model
    } as unknown as SourceControlPanelReadyProps
    return <SourceControlChangeScopeBar {...props} />
  }
  render(
    <TooltipProvider>
      <Harness />
    </TooltipProvider>
  )
  return calls
}

function openMenu(): void {
  fireEvent.pointerDown(screen.getByTestId('source-control-change-scope-trigger'), {
    button: 0,
    ctrlKey: false,
    pointerType: 'mouse'
  })
}

describe('SourceControlChangeScopeBar menu', () => {
  it('offers scopes as radio items, starts on the checked one and returns focus on Escape', async () => {
    renderBar()
    openMenu()
    const all = await screen.findByRole('menuitemradio', { name: /All changes/ })
    expect(all.getAttribute('aria-checked')).toBe('true')
    await waitFor(() => expect(document.activeElement).toBe(all))
    expect(
      screen.getByRole('menuitemradio', { name: /Uncommitted/ }).getAttribute('aria-checked')
    ).toBe('false')
    expect(screen.getByText('Commits on this branch')).toBeTruthy()

    fireEvent.keyDown(all, { key: 'ArrowDown' })
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('menuitemradio', { name: /Uncommitted/ })
      )
    )
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(screen.getByTestId('source-control-change-scope-trigger'))
  })

  it('supports keyboard entry, typing and exit through the commit filter', async () => {
    renderBar({
      history: {
        status: 'ready',
        result: {
          ...PAGE,
          items: Array.from({ length: 12 }, (_, index) => ({
            ...COMMIT,
            id: `commit-${index}`,
            subject: `Change ${index + 1}`
          }))
        }
      }
    })
    const trigger = screen.getByTestId('source-control-change-scope-trigger')
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    const all = await screen.findByRole('menuitemradio', { name: /All changes/ })
    await waitFor(() => expect(document.activeElement).toBe(all))
    const uncommitted = screen.getByRole('menuitemradio', { name: /Uncommitted/ })
    fireEvent.keyDown(all, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(uncommitted))
    const filter = screen.getByRole('textbox', { name: 'Filter commits' })
    fireEvent.keyDown(uncommitted, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(filter))
    fireEvent.keyDown(filter, { key: 'C' })
    fireEvent.change(filter, { target: { value: 'Change 12' } })
    expect(document.activeElement).toBe(filter)
    expect(screen.queryByRole('menuitemradio', { name: /^Change 1\b/ })).toBeNull()
    const commit = screen.getByRole('menuitemradio', { name: /^Change 12/ })
    fireEvent.keyDown(filter, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(commit))
    fireEvent.keyDown(commit, { key: 'ArrowUp' })
    await waitFor(() => expect(document.activeElement).toBe(filter))
    fireEvent.keyDown(filter, { key: 'ArrowUp' })
    await waitFor(() => expect(document.activeElement).toBe(uncommitted))
    fireEvent.keyDown(uncommitted, { key: 'ArrowDown' })
    await waitFor(() => expect(document.activeElement).toBe(filter))
    fireEvent.keyDown(filter, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull())
    expect(document.activeElement).toBe(trigger)
  })

  it('shows a picked commit with its meta line and returns to All changes with ×', async () => {
    renderBar()
    openMenu()
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /Retire PR recovery/ }))
    const trigger = screen.getByTestId('source-control-change-scope-trigger')
    await waitFor(() => expect(trigger.textContent).toContain('Retire PR recovery epochs'))
    expect(screen.getByTestId('source-control-change-scope').textContent).toContain(
      '191266b · Jinjing'
    )

    fireEvent.click(screen.getByRole('button', { name: 'Show all changes' }))
    expect(trigger.textContent).toContain('All changes')
    expect(screen.queryByRole('button', { name: 'Show all changes' })).toBeNull()
  })

  it('retries a failed refresh even when cached history remains available', async () => {
    const calls = renderBar({ history: { status: 'error', error: 'offline', result: PAGE } })
    openMenu()
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Retry' }))
    expect(calls.refreshGitHistory).toHaveBeenCalledWith({ wakeWslDistro: true })
  })
})

describe('SourceControlChangeScopeBar summary and Open diff', () => {
  it('opens the whole scope for All changes and links the commit count to the menu', async () => {
    const calls = renderBar()
    fireEvent.click(screen.getByTestId('source-control-change-scope-open-diff'))
    expect(calls.openAllDiffs).toHaveBeenCalledWith(
      'wt-1',
      '/repo',
      undefined,
      undefined,
      undefined,
      {
        wholeScope: true
      }
    )
    fireEvent.click(screen.getByRole('button', { name: '1 commit' }))
    expect(await screen.findByRole('menu')).toBeTruthy()
  })

  it('hides the commit count when nothing is ahead', () => {
    renderBar({ summary: { ...READY, commitsAhead: 0 } })
    expect(screen.queryByRole('button', { name: /commit/ })).toBeNull()
  })

  it('waits for branch compare instead of opening a partial All changes diff', () => {
    const calls = renderBar({ summary: { ...READY, status: 'loading' } })
    const openDiff = screen.getByTestId('source-control-change-scope-open-diff')
    expect(openDiff.getAttribute('aria-disabled')).toBe('true')
    fireEvent.click(openDiff)
    expect(calls.openAllDiffs).not.toHaveBeenCalled()
  })

  it('opens Uncommitted alone and a picked commit through the commit diff', () => {
    const uncommitted = renderBar({ initialScope: { kind: 'uncommitted' } })
    fireEvent.click(screen.getByTestId('source-control-change-scope-open-diff'))
    expect(uncommitted.openAllDiffs).toHaveBeenCalledWith(
      'wt-1',
      '/repo',
      undefined,
      undefined,
      undefined,
      { uncommittedOnly: true }
    )
    cleanup()

    const commit = renderBar({
      initialScope: {
        kind: 'commit',
        commit: COMMIT,
        pickedBaseOid: 'b1',
        pickedFromBranchPage: true
      }
    })
    act(() => {
      fireEvent.click(screen.getByTestId('source-control-change-scope-open-diff'))
    })
    expect(commit.openHistoryCommitDiff).toHaveBeenCalledWith(COMMIT)
  })
})
