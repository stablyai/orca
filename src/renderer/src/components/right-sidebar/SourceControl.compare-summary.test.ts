import { describe, expect, it, vi } from 'vitest'
import {
  CompareSummary,
  CompareSummaryToolbarButton,
  resolveSourceControlBaseRef,
  shouldShowCompareSummary
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

function collectText(node: unknown): string {
  if (node == null) {
    return ''
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('')
  }
  const element = node as ReactElementLike
  return collectText(element.props?.children)
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

function collectCompareSummaryToolbarLabels(node: unknown): string[] {
  const labels: string[] = []
  visit(node, (entry) => {
    if (entry.type === CompareSummaryToolbarButton && typeof entry.props.label === 'string') {
      labels.push(entry.props.label)
    }
  })
  return labels
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

describe('SourceControl compare summary', () => {
  it('prefers the worktree creation base for branch compare', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: 'refs/remotes/origin/main',
        repoBaseRef: 'main',
        defaultBaseRef: 'origin/main'
      })
    ).toBe('refs/remotes/origin/main')
  })

  it('falls back to repo and default base refs when worktree metadata is absent', () => {
    expect(
      resolveSourceControlBaseRef({
        worktreeBaseRef: '  ',
        repoBaseRef: ' origin/release ',
        defaultBaseRef: 'origin/main'
      })
    ).toBe('origin/release')

    expect(
      resolveSourceControlBaseRef({
        repoBaseRef: null,
        defaultBaseRef: 'origin/main'
      })
    ).toBe('origin/main')
  })

  it('wires toolbar actions without rendering the dead view-mode toggle', () => {
    const onChangeBaseRef = vi.fn()
    const onRetry = vi.fn()
    const node = CompareSummary({
      summary: readySummary,
      onChangeBaseRef,
      onRetry
    })

    expect(collectCompareSummaryToolbarLabels(node)).toEqual([
      'Change base ref',
      'Refresh branch compare'
    ])

    const changeBaseRef = findCompareSummaryToolbarButton(node, 'Change base ref').props.onClick
    if (typeof changeBaseRef === 'function') {
      changeBaseRef()
    }
    expect(onChangeBaseRef).toHaveBeenCalledTimes(1)

    const refresh = findCompareSummaryToolbarButton(node, 'Refresh branch compare').props.onClick
    if (typeof refresh === 'function') {
      refresh()
    }
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('omits the whole compare row when the branch has no commits ahead', () => {
    const cleanSummary = { ...readySummary, commitsAhead: 0 }
    const node = CompareSummary({
      summary: cleanSummary,
      onChangeBaseRef: vi.fn(),
      onRetry: vi.fn()
    })

    expect(shouldShowCompareSummary(cleanSummary)).toBe(false)
    expect(node).toBeNull()
    const text = collectText(node)
    expect(text).not.toContain('0 commits ahead')
    expect(text).not.toContain('origin/main')
  })

  it('keeps non-zero summary copy compact', () => {
    const node = CompareSummary({
      summary: readySummary,
      onChangeBaseRef: vi.fn(),
      onRetry: vi.fn()
    })

    const text = collectText(node)
    expect(text).toContain('1 ahead')
    expect(text).not.toContain('1 commit ahead of origin/main')
  })

  it('omits the view-mode toggle from unavailable compare rows', () => {
    const node = CompareSummary({
      summary: {
        ...readySummary,
        status: 'error',
        errorMessage: 'Unable to compare'
      },
      onChangeBaseRef: vi.fn(),
      onRetry: vi.fn()
    })

    expect(collectCompareSummaryToolbarLabels(node)).toEqual(['Change base ref', 'Retry'])
  })
})
