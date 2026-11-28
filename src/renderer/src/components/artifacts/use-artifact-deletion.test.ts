// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ArtifactListItem } from '../../../../shared/artifacts/artifacts'
import { useArtifactDeletion } from './use-artifact-deletion'

const mocks = vi.hoisted(() => {
  const pending = new Map<string, (status: 'ok' | 'failed') => void>()
  const state = { settings: { skipDeleteArtifactConfirm: true }, orcaProfileAuthStatus: {} }
  return { pending, state }
})

vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: (_runtime: unknown, _method: string, params: { id: string }) =>
    new Promise((resolve) => mocks.pending.set(params.id, (status) => resolve({ status })))
}))
vi.mock('@/components/dismiss/confirmation/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => () => Promise.resolve(true)
}))
vi.mock('@/components/dismiss/confirmation/confirmation-skip-preference', () => ({
  persistConfirmationSkipPreference: () => {}
}))
vi.mock('@/store', () => {
  const useAppStore = (selector: (state: unknown) => unknown) =>
    selector({
      ...mocks.state,
      updateSettings: () => {},
      openSettingsPage: () => {},
      openSettingsTarget: () => {}
    })
  useAppStore.getState = () => mocks.state
  return { useAppStore }
})
vi.mock('@/i18n/use-translate', () => ({
  useTranslate: () => (_key: string, fallback: string) => fallback
}))
vi.mock('./useArtifactPagination', () => ({
  artifactAccountIdentity: () => 'account-1'
}))

function item(slug: string): ArtifactListItem {
  return {
    shareUrl: `https://example.com/a/${slug}`,
    artifact: {
      version: 1,
      slug,
      title: `Sample ${slug}`,
      originalFileName: null,
      sourceContentType: 'text/markdown',
      renderedContentType: 'text/html',
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
      expiresAt: '2026-07-01T00:00:00.000Z',
      byteSize: 1,
      deletedAt: null
    }
  }
}

// Lets the awaited confirm and each RPC continuation run.
const flush = async (): Promise<void> => {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
}

function renderDeletion() {
  const removeArtifact = vi.fn()
  const setError = vi.fn()
  const hook = renderHook(() =>
    useArtifactDeletion({
      accountIdentity: 'account-1',
      refreshAuth: () => Promise.resolve(),
      removeArtifact,
      setError
    })
  )
  return { ...hook, removeArtifact, setError }
}

beforeEach(() => mocks.pending.clear())
afterEach(() => cleanup())

describe('useArtifactDeletion per-row batches', () => {
  it('while A and B are deleting, deleting A, B and C again sends only C', async () => {
    const { result, removeArtifact } = renderDeletion()
    void act(() => void result.current.deleteArtifacts([item('A'), item('B')]))
    await flush()
    expect([...result.current.deletingSlugs].sort()).toEqual(['A', 'B'])
    expect([...mocks.pending.keys()]).toEqual(['A'])

    void act(() => void result.current.deleteArtifacts([item('A'), item('B'), item('C')]))
    await flush()
    expect([...mocks.pending.keys()]).toEqual(['A', 'C'])
    expect([...result.current.deletingSlugs].sort()).toEqual(['A', 'B', 'C'])

    mocks.pending.get('C')?.('ok')
    await flush()
    expect(removeArtifact).toHaveBeenCalledWith('account-1', 'C')
    expect(removeArtifact).not.toHaveBeenCalledWith('account-1', 'A')
    expect(result.current.deletedAnnouncement.count).toBe(1)
  })

  it('announces each batch once, from its own deleted count', async () => {
    const { result } = renderDeletion()
    void act(() => void result.current.deleteArtifacts([item('A'), item('B')]))
    await flush()
    const before = result.current.deletedAnnouncement

    mocks.pending.get('A')?.('ok')
    await flush()
    // Mid-batch: nothing announced yet.
    expect(result.current.deletedAnnouncement).toEqual(before)

    mocks.pending.get('B')?.('ok')
    await flush()
    expect(result.current.deletedAnnouncement).toEqual({ count: 2, seq: before.seq + 1 })
  })

  it('announces only what was deleted when the batch stops on a failure', async () => {
    const { result, setError } = renderDeletion()
    void act(() => void result.current.deleteArtifacts([item('A'), item('B'), item('C')]))
    await flush()
    mocks.pending.get('A')?.('ok')
    await flush()
    mocks.pending.get('B')?.('failed')
    await flush()
    expect(mocks.pending.has('C')).toBe(false)
    expect(result.current.deletedAnnouncement.count).toBe(1)
    expect(setError).toHaveBeenCalledTimes(1)
    expect(result.current.deletingSlugs.size).toBe(0)
  })
})
