import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/types'
import {
  handleWorktreeParentPickerKeyDown,
  selectWorktreeParent
} from './WorktreeParentPickerPopover'
import {
  clampWorktreeParentPickerIndex,
  filterWorktreeParentCandidates,
  getWorktreeParentPickerItemValue
} from './worktree-parent-picker-filtering'
import {
  clampWorktreeParentPickerAnchorTop,
  estimateWorktreeParentPickerHeight
} from './worktree-parent-picker-placement'

afterEach(() => {
  vi.restoreAllMocks()
})

function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo::/workspaces/parent',
    instanceId: 'parent-instance',
    repoId: 'repo',
    path: '/workspaces/parent',
    head: 'abc',
    branch: 'refs/heads/feature/parent',
    isBare: false,
    isMainWorktree: false,
    isSparse: false,
    displayName: 'Parent Worktree',
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

describe('selectWorktreeParent', () => {
  it('closes and assigns the selected parent to the captured child', () => {
    const assignWorktreeParent = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()
    const showError = vi.fn()

    selectWorktreeParent({
      childWorktreeId: 'child',
      parentWorktreeId: 'parent',
      assignWorktreeParent,
      close,
      showError
    })

    expect(close).toHaveBeenCalledTimes(1)
    expect(assignWorktreeParent).toHaveBeenCalledWith('child', { parentWorktreeId: 'parent' })
    expect(showError).not.toHaveBeenCalled()
  })

  it('shows sanitized failure copy after closing the picker', async () => {
    const assignWorktreeParent = vi.fn().mockRejectedValue(new Error('stale parent'))
    const close = vi.fn()
    const showError = vi.fn()
    vi.spyOn(console, 'error').mockImplementation(() => {})

    selectWorktreeParent({
      childWorktreeId: 'child',
      parentWorktreeId: 'parent',
      assignWorktreeParent,
      close,
      showError
    })
    await Promise.resolve()

    expect(close).toHaveBeenCalledTimes(1)
    expect(showError).toHaveBeenCalledWith('Failed to set parent worktree')
  })

  it('does nothing without a captured child id', () => {
    const assignWorktreeParent = vi.fn().mockResolvedValue(undefined)
    const close = vi.fn()

    selectWorktreeParent({
      childWorktreeId: null,
      parentWorktreeId: 'parent',
      assignWorktreeParent,
      close,
      showError: vi.fn()
    })

    expect(close).not.toHaveBeenCalled()
    expect(assignWorktreeParent).not.toHaveBeenCalled()
  })
})

describe('getWorktreeParentPickerItemValue', () => {
  it('includes workspace-facing fields used by command filtering', () => {
    expect(getWorktreeParentPickerItemValue(makeWorktree())).toContain('Parent Worktree')
    expect(getWorktreeParentPickerItemValue(makeWorktree())).toContain('feature/parent')
    expect(getWorktreeParentPickerItemValue(makeWorktree())).toContain('/workspaces/parent')
  })
})

describe('filterWorktreeParentCandidates', () => {
  const alpha = makeWorktree({ id: 'alpha', displayName: 'alpha', path: '/workspaces/alpha' })
  const beta = makeWorktree({
    id: 'beta',
    displayName: 'beta',
    path: '/workspaces/beta',
    branch: 'refs/heads/feature/alpha-follow-up'
  })

  it('returns every candidate when the search is blank', () => {
    expect(filterWorktreeParentCandidates([alpha, beta], '   ')).toEqual([alpha, beta])
  })

  it('drops non-matching candidates and ranks the closest match first', () => {
    expect(filterWorktreeParentCandidates([beta, alpha], 'alpha')).toEqual([alpha, beta])
    expect(filterWorktreeParentCandidates([alpha, beta], 'nothing-matches')).toEqual([])
  })

  it('matches on branch and path, not just display name', () => {
    expect(filterWorktreeParentCandidates([alpha, beta], 'follow-up')).toEqual([beta])
    expect(filterWorktreeParentCandidates([alpha, beta], '/workspaces/beta')).toEqual([beta])
  })
})

describe('estimateWorktreeParentPickerHeight', () => {
  it('grows with the candidate count up to the list cap', () => {
    expect(estimateWorktreeParentPickerHeight(1)).toBe(79 + 56)
    expect(estimateWorktreeParentPickerHeight(3)).toBe(79 + 168)
    // Why: matches the height measured on a rendered picker in the dev app.
    expect(estimateWorktreeParentPickerHeight(300)).toBe(367)
  })

  it('reserves a single row when nothing is eligible', () => {
    expect(estimateWorktreeParentPickerHeight(0)).toBe(79 + 56)
  })
})

describe('clampWorktreeParentPickerAnchorTop', () => {
  it('leaves an anchor that already fits where it is', () => {
    expect(clampWorktreeParentPickerAnchorTop(200, 333, 900)).toBe(200)
  })

  it('lifts an anchor whose popover would run off the bottom', () => {
    expect(clampWorktreeParentPickerAnchorTop(800, 333, 900)).toBe(900 - 12 - 333)
  })

  it('keeps an anchor above the window from riding off the top', () => {
    expect(clampWorktreeParentPickerAnchorTop(-40, 333, 900)).toBe(12)
  })

  it('pins to the top padding when the window is shorter than the popover', () => {
    expect(clampWorktreeParentPickerAnchorTop(120, 333, 300)).toBe(12)
  })
})

describe('clampWorktreeParentPickerIndex', () => {
  it('keeps the highlight inside the filtered result window', () => {
    expect(clampWorktreeParentPickerIndex(5, 3)).toBe(2)
    expect(clampWorktreeParentPickerIndex(-1, 3)).toBe(0)
    expect(clampWorktreeParentPickerIndex(1, 3)).toBe(1)
  })

  it('collapses to zero when nothing matches', () => {
    expect(clampWorktreeParentPickerIndex(4, 0)).toBe(0)
  })
})

describe('parent picker keyboard input', () => {
  it.each([
    { isComposing: true, keyCode: 13 },
    { isComposing: false, keyCode: 229 }
  ])('leaves IME composition keys to the input method', (nativeEvent) => {
    const moveHighlight = vi.fn()
    const selectParent = vi.fn()
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    handleWorktreeParentPickerKeyDown({
      event: {
        key: 'Enter',
        nativeEvent,
        preventDefault,
        stopPropagation
      } as unknown as React.KeyboardEvent<HTMLInputElement>,
      candidates: [{ id: 'parent' }],
      activeIndex: 0,
      moveHighlight,
      selectParent
    })

    expect(moveHighlight).not.toHaveBeenCalled()
    expect(selectParent).not.toHaveBeenCalled()
    expect(preventDefault).not.toHaveBeenCalled()
    expect(stopPropagation).not.toHaveBeenCalled()
  })
})
