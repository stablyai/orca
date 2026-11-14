// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { useRetiredWorktreeNames } from './useRetiredWorktreeNames'

const listRetiredNames = vi.fn()
const registry = (names: string[], exhaustedTiers = 0) => ({ exhaustedTiers, names })

beforeEach(() => {
  listRetiredNames.mockReset()
  Object.assign(window, { api: { worktrees: { listRetiredNames } } })
})

afterEach(cleanup)

describe('useRetiredWorktreeNames', () => {
  it('keeps the previous names while a refresh is in flight', async () => {
    // Keep spent names during mutation-triggered refetches so create-multiple cannot suggest one again.
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
})
