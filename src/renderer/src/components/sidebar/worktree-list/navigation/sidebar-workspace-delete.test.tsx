import { beforeEach, expect, it, vi } from 'vitest'
import { useStore } from 'zustand'
import { createUIStore } from '@/store/slices/ui/ui-slice-test-harness'
import type { AppState } from '@/store/types'

import { resolveSidebarWorkspaceDeleteIntent } from './sidebar-workspace-delete'

import { repo, worktree } from '../grouping/worktree-list-groups-test-fixtures'
let store: ReturnType<typeof createUIStore>
vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: AppState) => unknown) => useStore(store, selector), {
    getState: () => store.getState()
  })
}))

const a = { ...worktree, id: 'a', instanceId: 'inc-a', hostId: 'local' as const }
const b = { ...worktree, id: 'b', instanceId: 'inc-b', hostId: 'local' as const }
const twin = { ...b, hostId: 'runtime:other' as const, instanceId: 'inc-remote' }
beforeEach(() => {
  store = createUIStore()
  store.setState({
    keybindings: {},
    activeWorktreeId: 'a',
    deleteStateByWorktreeId: {},
    sshTargetLabels: new Map(),
    repos: [repo],
    worktreesByRepo: { [repo.id]: [a, b, twin] }
  })
})
it('keeps an unhosted local batch when a sibling SSH repo shares its id', () => {
  const localA = { ...a, hostId: undefined }
  const localB = { ...b, hostId: undefined }
  const sshRepo = { ...repo, connectionId: 'direct' }
  store.setState({ repos: [repo, sshRepo] })
  const intent = resolveSidebarWorkspaceDeleteIntent({
    selectedWorktrees: [localA, localB],
    focusedWorktree: localB,
    repoMap: new Map([[repo.id, sshRepo]])
  })
  expect(intent).toEqual({
    kind: 'batch',
    worktrees: [
      { id: 'a', instanceId: 'inc-a', hostId: undefined },
      { id: 'b', instanceId: 'inc-b', hostId: undefined }
    ]
  })
})
