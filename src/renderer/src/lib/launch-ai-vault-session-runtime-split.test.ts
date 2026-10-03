// Real-store coverage: a session dropped on a pane edge of a paired-runtime worktree must split.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import type { CreateWebRuntimeSessionTerminalArgs } from '@/runtime/web-runtime-session-types'
import { createTestStore, makeWorktree, seedStore } from '../store/slices/store-test-helpers'
import { createStoreCascadesMockApi } from '../store/slices/store-cascades-test-harness'

const storeBox = vi.hoisted(() => {
  const box: { store: unknown } = { store: null }
  return box
})
const runtimeMocks = vi.hoisted(() => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  isWebRuntimeSessionActive: vi.fn(() => true)
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))

vi.mock('@/store', () => ({
  get useAppStore() {
    return storeBox.store
  }
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => 'env-1'
}))

vi.mock('@/runtime/web-runtime-session', () => runtimeMocks)

createStoreCascadesMockApi()

const WT = 'repo1::/path/wt1'

function seedRuntimeWorktreeWithTerminal() {
  const store = createTestStore()
  storeBox.store = store
  seedStore(store, {
    settings: getDefaultSettings('/tmp'),
    worktreesByRepo: { repo1: [makeWorktree({ id: WT, repoId: 'repo1', path: '/path/wt1' })] },
    activeWorktreeId: WT
  })
  store.getState().createTab(WT)
  const sourceGroupId = store.getState().groupsByWorktree[WT][0].id
  return { store, sourceGroupId }
}

async function dropSessionOnRightEdge(sourceGroupId: string) {
  const { launchAiVaultSessionInNewTab } = await import('./launch-ai-vault-session')
  return launchAiVaultSessionInNewTab({
    agent: 'codex',
    worktreeId: WT,
    command: "codex resume 'session-1'",
    providerSession: { key: 'session_id', id: 'session-1' },
    targetGroupId: sourceGroupId,
    splitDirection: 'right'
  })
}

describe('launchAiVaultSessionInNewTab on a paired-runtime worktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.isWebRuntimeSessionActive.mockReturnValue(true)
  })

  it('splits the pane and lands the resumed session in the new group', async () => {
    const { store, sourceGroupId } = seedRuntimeWorktreeWithTerminal()
    runtimeMocks.createWebRuntimeSessionTerminal.mockImplementation(
      async (args: CreateWebRuntimeSessionTerminalArgs) => {
        // Stands in for the placement record settling the mirrored tab into its requested group.
        store.getState().createTab(WT, args.targetGroupId)
        return { status: 'created' }
      }
    )

    const result = await dropSessionOnRightEdge(sourceGroupId)

    const splitGroupId = store.getState().activeGroupIdByWorktree[WT]
    expect(splitGroupId).not.toBe(sourceGroupId)
    expect(store.getState().layoutByWorktree[WT]).toEqual(
      expect.objectContaining({
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: sourceGroupId },
        second: { type: 'leaf', groupId: splitGroupId }
      })
    )
    expect(runtimeMocks.createWebRuntimeSessionTerminal).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: 'env-1', targetGroupId: splitGroupId })
    )
    expect(result).toEqual(expect.objectContaining({ tabId: null, groupId: splitGroupId }))
    if (result.tabId === null) {
      await expect(result.runtimeLaunch).resolves.toEqual({ status: 'created' })
    }
    const groups = store.getState().groupsByWorktree[WT]
    expect(groups.map((group) => group.id)).toEqual([sourceGroupId, splitGroupId])
    expect(groups[1].tabOrder).toHaveLength(1)
  })

  it.each([
    ['the paired runtime cannot launch the session', { status: 'failed', message: 'offline' }],
    ['the created session never lands in the split', { status: 'created' }]
  ])('removes the split it created when %s', async (_case, outcome) => {
    const { store, sourceGroupId } = seedRuntimeWorktreeWithTerminal()
    runtimeMocks.createWebRuntimeSessionTerminal.mockResolvedValue(outcome)

    const result = await dropSessionOnRightEdge(sourceGroupId)

    expect(store.getState().groupsByWorktree[WT]).toHaveLength(2)
    if (result.tabId === null) {
      await expect(result.runtimeLaunch).resolves.toEqual(outcome)
    }
    expect(store.getState().groupsByWorktree[WT].map((group) => group.id)).toEqual([sourceGroupId])
    expect(store.getState().layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: sourceGroupId })
    expect(store.getState().activeGroupIdByWorktree[WT]).toBe(sourceGroupId)
  })

  it('keeps the split when the user dropped another tab into it while the launch was pending', async () => {
    const { store, sourceGroupId } = seedRuntimeWorktreeWithTerminal()
    let failLaunch!: () => void
    runtimeMocks.createWebRuntimeSessionTerminal.mockReturnValue(
      new Promise((resolve) => {
        failLaunch = () => resolve({ status: 'failed', message: 'offline' })
      })
    )

    const result = await dropSessionOnRightEdge(sourceGroupId)
    const splitGroupId = store.getState().activeGroupIdByWorktree[WT]
    store.getState().createTab(WT, splitGroupId)
    failLaunch()
    if (result.tabId === null) {
      await result.runtimeLaunch
    }

    const split = store.getState().groupsByWorktree[WT].find((group) => group.id === splitGroupId)
    expect(split?.tabOrder).toHaveLength(1)
  })
})
