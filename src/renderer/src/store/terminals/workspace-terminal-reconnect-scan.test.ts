import { describe, expect, it, vi } from 'vitest'
import type { DirectSshAuthority, SshProviderEpoch } from '../../../../shared/ssh-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { createTestStore, makeTab, makeWorktree } from '../slices/store-test-helpers'

describe('restored terminal binding projection', () => {
  it('binds 250 restored tabs with linear tab reads and one publication', async () => {
    const count = 250
    let tabIdReads = 0
    const worktree = makeWorktree({ id: 'repo::/tmp/wt', repoId: 'repo' })
    const tabIds = Array.from({ length: count }, (_, index) => `tab-${index}`)
    const tabs = tabIds.map((id) => {
      const tab = makeTab({ id, worktreeId: worktree.id })
      Object.defineProperty(tab, 'id', {
        enumerable: true,
        get: () => {
          tabIdReads++
          return id
        }
      })
      return tab
    })
    const store = createTestStore()
    store.setState({
      worktreesByRepo: { [worktree.repoId]: [worktree] },
      tabsByWorktree: { [worktree.id]: tabs },
      pendingReconnectWorktreeIds: [worktree.id],
      pendingReconnectTabByWorktree: { [worktree.id]: tabIds },
      pendingReconnectPtyIdByTabId: Object.fromEntries(tabIds.map((id) => [id, `pty-${id}`]))
    })
    const published = vi.fn()
    store.subscribe(published)
    tabIdReads = 0
    await store.getState().reconnectPersistedTerminals()
    expect(tabIdReads).toBeLessThanOrEqual(count * 8)
    expect(store.getState().tabsByWorktree[worktree.id]?.map((tab) => tab.ptyId)).toEqual(
      tabIds.map((id) => `pty-${id}`)
    )
    expect(store.getState().ptyIdsByTabId).toEqual(
      Object.fromEntries(tabIds.map((id) => [id, [`pty-${id}`]]))
    )
    expect(store.getState().workspaceSessionReady).toBe(true)
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([])
    expect(published).toHaveBeenCalledOnce()
  })

  it('keeps first-tab fallback and updates every row bearing its ID', async () => {
    const workspace = 'repo::/tmp/wt'
    const first = makeTab({ id: 'duplicate', worktreeId: workspace, title: 'First' })
    const duplicate = makeTab({ id: 'duplicate', worktreeId: workspace, title: 'Second' })
    const untouched = makeTab({ id: 'other', worktreeId: workspace })
    const store = createTestStore()
    store.setState({
      tabsByWorktree: { [workspace]: [first, duplicate, untouched] },
      pendingReconnectWorktreeIds: [workspace],
      pendingReconnectTabByWorktree: { [workspace]: [] },
      pendingReconnectPtyIdByTabId: { duplicate: 'pty-duplicate', other: 'pty-other' }
    })
    await store.getState().reconnectPersistedTerminals()
    const result = store.getState().tabsByWorktree[workspace]
    expect(result).toEqual([
      { ...first, ptyId: 'pty-duplicate' },
      { ...duplicate, ptyId: 'pty-duplicate' },
      untouched
    ])
    expect(result?.[2]).toBe(untouched)
    expect(store.getState().ptyIdsByTabId).toEqual({ duplicate: ['pty-duplicate'] })
  })

  it('keeps scoped SSH folder bindings and skips other-host wake hints', async () => {
    const authority: DirectSshAuthority = {
      targetId: 'target-a',
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This fixture reuses one opaque provider epoch for its current authority.
      providerEpoch: 'epoch-a' as SshProviderEpoch,
      connectionGeneration: 1
    }
    const folder = folderWorkspaceKey('folder-a')
    const sibling = 'repo::/sibling'
    const accepted = makeTab({ id: 'accepted', worktreeId: folder })
    const wrongHost = makeTab({ id: 'wrong-host', worktreeId: folder })
    const siblingTabs = [makeTab({ id: 'sibling', worktreeId: sibling })]
    const store = createTestStore()
    store.setState({
      sshConnectionStates: new Map([
        [
          authority.targetId,
          { ...authority, status: 'connected', error: null, reconnectAttempt: 0 }
        ]
      ]),
      tabsByWorktree: { [folder]: [accepted, wrongHost], [sibling]: siblingTabs },
      pendingReconnectWorktreeIds: [folder, sibling],
      pendingReconnectTabByWorktree: {
        [folder]: ['accepted', 'wrong-host'],
        [sibling]: ['sibling']
      },
      pendingReconnectPtyIdByTabId: {
        accepted: 'ssh:target-a@@pty-accepted',
        'wrong-host': 'ssh:target-b@@pty-wrong',
        sibling: 'ssh:target-b@@pty-sibling'
      }
    })
    await store.getState().reconnectPersistedTerminals(undefined, {
      directSshAuthority: authority,
      workspaceKeys: [folder]
    })
    expect(store.getState().tabsByWorktree[folder]).toEqual([
      { ...accepted, ptyId: 'ssh:target-a@@pty-accepted' },
      wrongHost
    ])
    expect(store.getState().tabsByWorktree[folder]?.[1]).toBe(wrongHost)
    expect(store.getState().tabsByWorktree[sibling]).toBe(siblingTabs)
    expect(store.getState().pendingReconnectWorktreeIds).toEqual([sibling])
    expect(store.getState().pendingReconnectPtyIdByTabId).toEqual({
      sibling: 'ssh:target-b@@pty-sibling'
    })
    expect(store.getState().ptyIdsByTabId).toEqual({ accepted: ['ssh:target-a@@pty-accepted'] })
  })

  it('does not publish when reconnect was already aborted', async () => {
    const store = createTestStore()
    const before = store.getState()
    const published = vi.fn()
    store.subscribe(published)
    await store.getState().reconnectPersistedTerminals(AbortSignal.abort())
    expect(store.getState()).toBe(before)
    expect(published).not.toHaveBeenCalled()
  })
})
