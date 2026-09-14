// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useRetiredWorktreeNames } from './useRetiredWorktreeNames'

const listRetiredNames = vi.fn()
const registry = (names: string[], exhaustedTiers = 0) => ({ exhaustedTiers, names })

beforeEach(() => {
  listRetiredNames.mockReset()
  Object.assign(window, { api: { worktrees: { listRetiredNames } } })
})

describe('useRetiredWorktreeNames', () => {
  it('keeps the previous names while a refresh is in flight', async () => {
    // Why: refreshKey changes on every workspace-list mutation, so create-multiple refetches after
    // each create. Dropping to empty in between would suggest a spent name in exactly that window.
    listRetiredNames.mockResolvedValueOnce(registry(['nautilus']))
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useRetiredWorktreeNames('repo-1', key),
      { initialProps: { key: 'a' } }
    )
    await waitFor(() => expect(result.current).toEqual(registry(['nautilus'])))

    let resolveSecond: (loaded: ReturnType<typeof registry>) => void = () => {}
    listRetiredNames.mockReturnValueOnce(
      new Promise<ReturnType<typeof registry>>((resolve) => {
        resolveSecond = resolve
      })
    )
    rerender({ key: 'b' })

    expect(result.current).toEqual(registry(['nautilus']))

    resolveSecond(registry(['nautilus', 'seahorse'], 1))
    await waitFor(() => expect(result.current).toEqual(registry(['nautilus', 'seahorse'], 1)))
  })

  it('returns a referentially stable registry across refreshes that change nothing', async () => {
    // The suggestion memo downstream keys on this object; a new identity per refetch reruns it.
    const loaded = registry(['nautilus'])
    listRetiredNames.mockResolvedValue(loaded)
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useRetiredWorktreeNames('repo-1', key),
      { initialProps: { key: 'a' } }
    )
    await waitFor(() => expect(result.current).toEqual(registry(['nautilus'])))
    const first = result.current

    rerender({ key: 'b' })

    expect(result.current).toBe(first)
  })

  it('drops names when the repo changes rather than showing another repo pool', async () => {
    listRetiredNames.mockResolvedValueOnce(registry(['nautilus']))
    const { result, rerender } = renderHook(
      ({ repoId }: { repoId: string }) => useRetiredWorktreeNames(repoId, 'key'),
      { initialProps: { repoId: 'repo-1' } }
    )
    await waitFor(() => expect(result.current).toEqual(registry(['nautilus'])))

    listRetiredNames.mockReturnValueOnce(new Promise<never>(() => {}))
    rerender({ repoId: 'repo-2' })

    expect(result.current).toEqual(registry([]))
  })

  it('keeps previously loaded names when a refresh fails', async () => {
    listRetiredNames.mockResolvedValueOnce(registry(['nautilus']))
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useRetiredWorktreeNames('repo-1', key),
      { initialProps: { key: 'a' } }
    )
    await waitFor(() => expect(result.current).toEqual(registry(['nautilus'])))

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    listRetiredNames.mockRejectedValueOnce(new Error('host unreachable'))
    rerender({ key: 'b' })

    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(result.current).toEqual(registry(['nautilus']))
  })

  it('refetches when the refresh key changes', async () => {
    listRetiredNames.mockResolvedValue(registry(['nautilus']))
    const { rerender } = renderHook(
      ({ key }: { key: string }) => useRetiredWorktreeNames('repo-1', key),
      { initialProps: { key: 'a' } }
    )
    await waitFor(() => expect(listRetiredNames).toHaveBeenCalledTimes(1))

    rerender({ key: 'b' })
    await waitFor(() => expect(listRetiredNames).toHaveBeenCalledTimes(2))
  })
})
