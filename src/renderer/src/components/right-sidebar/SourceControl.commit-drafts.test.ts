import { describe, expect, it, vi } from 'vitest'
import { ListTree } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  CompareSummary,
  CompareSummaryToolbarButton,
  getNextSourceControlViewMode,
  normalizeSourceControlViewMode,
  readCommitDraftForWorktree,
  requestSourceControlViewModePreferenceWrite,
  type SourceControlViewModePreferenceWriteState,
  writeCommitDraftForWorktree
} from './SourceControl'
import type { GitBranchCompareSummary } from '../../../../shared/types'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findInnerButton(node: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === Button) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('inner Button not found')
  }
  return found
}

function findCompareSummaryToolbarButton(node: unknown, label: string): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === CompareSummaryToolbarButton && entry.props.label === label) {
      found = entry
    }
  })
  if (!found) {
    throw new Error(`toolbar button not found: ${label}`)
  }
  return found
}

const readySummary: GitBranchCompareSummary = {
  baseRef: 'origin/main',
  baseOid: 'base',
  compareRef: 'feature',
  headOid: 'head',
  mergeBase: 'base',
  changedFiles: 2,
  commitsAhead: 1,
  status: 'ready'
}

describe('SourceControl commit drafts by worktree', () => {
  it('returns an empty draft when the selected worktree has no message', () => {
    expect(readCommitDraftForWorktree({}, 'wt-a')).toBe('')
  })

  it('restores each worktree draft when switching between worktrees', () => {
    let drafts = {}

    drafts = writeCommitDraftForWorktree(drafts, 'wt-a', 'feat: message for A')
    expect(readCommitDraftForWorktree(drafts, 'wt-a')).toBe('feat: message for A')

    drafts = writeCommitDraftForWorktree(drafts, 'wt-b', 'fix: message for B')
    expect(readCommitDraftForWorktree(drafts, 'wt-b')).toBe('fix: message for B')

    // Why: switching back must keep the prior draft for that worktree rather
    // than leaking the active worktree's text into all worktree views.
    expect(readCommitDraftForWorktree(drafts, 'wt-a')).toBe('feat: message for A')
  })
})

describe('SourceControl view mode preference', () => {
  it('normalizes missing and unknown persisted values to list', () => {
    expect(normalizeSourceControlViewMode(undefined)).toBe('list')
    expect(normalizeSourceControlViewMode(null)).toBe('list')
    expect(normalizeSourceControlViewMode('grid')).toBe('list')
  })

  it('preserves valid persisted view modes', () => {
    expect(normalizeSourceControlViewMode('list')).toBe('list')
    expect(normalizeSourceControlViewMode('tree')).toBe('tree')
  })

  it('toggles between list and tree', () => {
    expect(getNextSourceControlViewMode('list')).toBe('tree')
    expect(getNextSourceControlViewMode('tree')).toBe('list')
  })

  it('does not persist the fallback list mode before settings hydrate', () => {
    const writeState: SourceControlViewModePreferenceWriteState = {
      writeChain: Promise.resolve(),
      writeSeq: 0
    }
    const setOptimisticMode = vi.fn()
    const updateSettings = vi.fn()

    const result = requestSourceControlViewModePreferenceWrite({
      hydrated: false,
      currentMode: 'list',
      writeState,
      setOptimisticMode,
      updateSettings
    })

    expect(result).toBeNull()
    expect(setOptimisticMode).not.toHaveBeenCalled()
    expect(updateSettings).not.toHaveBeenCalled()
  })

  it('queues rapid toggle writes so the last intent clears optimistic state', async () => {
    const writeState: SourceControlViewModePreferenceWriteState = {
      writeChain: Promise.resolve(),
      writeSeq: 0
    }
    const optimisticModes: ('list' | 'tree' | null)[] = []
    const firstWrite: { resolve: (() => void) | null } = { resolve: null }
    const updateSettings = vi.fn(
      ({ sourceControlViewMode }: { sourceControlViewMode: 'list' | 'tree' }) => {
        if (sourceControlViewMode === 'tree') {
          return new Promise<void>((resolve) => {
            firstWrite.resolve = resolve
          })
        }
        return Promise.resolve()
      }
    )

    expect(
      requestSourceControlViewModePreferenceWrite({
        hydrated: true,
        currentMode: 'list',
        writeState,
        setOptimisticMode: (mode) => optimisticModes.push(mode),
        updateSettings
      })
    ).toBe('tree')
    await Promise.resolve()

    expect(
      requestSourceControlViewModePreferenceWrite({
        hydrated: true,
        currentMode: 'tree',
        writeState,
        setOptimisticMode: (mode) => optimisticModes.push(mode),
        updateSettings
      })
    ).toBe('list')
    await Promise.resolve()

    expect(updateSettings).toHaveBeenCalledTimes(1)
    expect(updateSettings).toHaveBeenLastCalledWith({ sourceControlViewMode: 'tree' })

    expect(firstWrite.resolve).not.toBeNull()
    firstWrite.resolve?.()
    await writeState.writeChain
    await Promise.resolve()

    expect(updateSettings).toHaveBeenCalledTimes(2)
    expect(updateSettings).toHaveBeenLastCalledWith({ sourceControlViewMode: 'list' })
    expect(optimisticModes).toEqual(['tree', 'list', null])
  })

  it('wires the compare toolbar toggle label and click handler from the rendered mode', () => {
    const onToggleViewMode = vi.fn()
    const node = CompareSummary({
      summary: readySummary,
      viewMode: 'tree',
      onChangeBaseRef: vi.fn(),
      onToggleViewMode,
      onRetry: vi.fn()
    })

    const toggle = findCompareSummaryToolbarButton(node, 'Show changes as list')
    expect(toggle.props.disabled).toBeUndefined()

    const onClick = toggle.props.onClick
    expect(typeof onClick).toBe('function')
    if (typeof onClick === 'function') {
      onClick()
    }
    expect(onToggleViewMode).toHaveBeenCalledTimes(1)
  })

  it('renders the hydrated-disabled toolbar toggle as inert', () => {
    const onToggleViewMode = vi.fn()
    const node = CompareSummary({
      summary: readySummary,
      viewMode: 'list',
      onChangeBaseRef: vi.fn(),
      onToggleViewMode,
      viewModeToggleDisabled: true,
      onRetry: vi.fn()
    })
    const toggle = findCompareSummaryToolbarButton(node, 'Show changes as tree')
    expect(toggle.props.disabled).toBe(true)

    const button = findInnerButton(
      CompareSummaryToolbarButton({
        icon: ListTree,
        label: 'Show changes as tree',
        onClick: onToggleViewMode,
        disabled: true
      })
    )
    expect(button.props['aria-disabled']).toBe(true)
    const onClick = button.props.onClick
    expect(typeof onClick).toBe('function')
    if (typeof onClick === 'function') {
      onClick()
    }
    expect(onToggleViewMode).not.toHaveBeenCalled()
  })
})
