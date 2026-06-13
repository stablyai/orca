import { describe, expect, it } from 'vitest'
import {
  isLazyModalId,
  resolveMountedLazyModalIds,
  type LazyModalId
} from './lazy-modal-mount-state'

describe('isLazyModalId', () => {
  it('recognizes only lazily retained root modal ids', () => {
    expect(isLazyModalId('quick-open')).toBe(true)
    expect(isLazyModalId('feature-tips')).toBe(true)
    expect(isLazyModalId('delete-worktree')).toBe(false)
    expect(isLazyModalId('none')).toBe(false)
  })
})

describe('resolveMountedLazyModalIds', () => {
  it('preserves set identity when the active modal is not lazy-mounted', () => {
    const mounted = new Set<LazyModalId>(['quick-open'])

    expect(resolveMountedLazyModalIds('none', mounted)).toBe(mounted)
  })

  it('preserves set identity when the lazy modal is already mounted', () => {
    const mounted = new Set<LazyModalId>(['workspace-cleanup'])

    expect(resolveMountedLazyModalIds('workspace-cleanup', mounted)).toBe(mounted)
  })

  it('adds newly opened lazy modal ids without mutating the existing set', () => {
    const mounted = new Set<LazyModalId>(['quick-open'])
    const resolved = resolveMountedLazyModalIds('feature-wall', mounted)

    expect(resolved).toEqual(new Set(['quick-open', 'feature-wall']))
    expect(resolved).not.toBe(mounted)
    expect(mounted).toEqual(new Set(['quick-open']))
  })
})
