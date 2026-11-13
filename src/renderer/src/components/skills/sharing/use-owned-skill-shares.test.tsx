// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillCloudOwnedShare } from '../../../../../shared/skill-cloud-contract'
import { noteSkillSharesChanged } from './skill-shares-changed'
import { useOwnedSkillShares } from './use-owned-skill-shares'

vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))

let server: SkillCloudOwnedShare[] = []
const listOwnedShares = vi.fn(async () => ({ status: 'ok' as const, value: [...server] }))
const revokeShare = vi.fn(async (id: string) => {
  server = server.filter((share) => share.id !== id)
  return { status: 'ok' as const }
})

function share(id: string): SkillCloudOwnedShare {
  return {
    id,
    url: `https://share.example/s/${id}`,
    packageId: `pkg_${id}`,
    name: id,
    description: '',
    createdAt: '2026-11-13T00:00:00.000Z'
  }
}

beforeEach(() => {
  server = []
  listOwnedShares.mockClear()
  revokeShare.mockClear()
  Object.assign(window, { api: { skills: { listOwnedShares, revokeShare } } })
})
afterEach(() => cleanup())

describe('useOwnedSkillShares (EP-7)', () => {
  it('lists a link published after the page opened, without reopening it', async () => {
    const { result } = renderHook(() => useOwnedSkillShares())
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.shares).toEqual([])

    server = [share('shr_1')]
    act(() => noteSkillSharesChanged())
    await waitFor(() => expect(result.current.shares.map((s) => s.id)).toEqual(['shr_1']))
    expect(listOwnedShares).toHaveBeenCalledTimes(2)
  })

  it('a revoke drops the link here and refreshes every other open list', async () => {
    server = [share('shr_1'), share('shr_2')]
    const here = renderHook(() => useOwnedSkillShares())
    const elsewhere = renderHook(() => useOwnedSkillShares())
    await waitFor(() => expect(elsewhere.result.current.shares).toHaveLength(2))

    await act(async () => {
      await here.result.current.revoke(share('shr_1'))
    })
    expect(here.result.current.shares.map((s) => s.id)).toEqual(['shr_2'])
    await waitFor(() => expect(elsewhere.result.current.shares.map((s) => s.id)).toEqual(['shr_2']))
  })

  it('stops listening once unmounted', async () => {
    const { unmount } = renderHook(() => useOwnedSkillShares())
    await waitFor(() => expect(listOwnedShares).toHaveBeenCalledTimes(1))
    unmount()
    act(() => noteSkillSharesChanged())
    expect(listOwnedShares).toHaveBeenCalledTimes(1)
  })
})
