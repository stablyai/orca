// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUIStore } from '@/store/slices/ui/ui-slice-test-harness'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { MIXED_GROUP } from '../../../../../../shared/folder-workspaces/folder-workspace-host-routing.test-fixture'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'
import { repo, worktree } from '../../worktree-list/grouping/worktree-list-groups-test-fixtures'

const runIntent = vi.hoisted(() => vi.fn())
const runDelete = vi.hoisted(() => vi.fn())
let store: ReturnType<typeof createUIStore>
vi.mock('@/store', () => ({
  useAppStore: { getState: () => store.getState(), subscribe: () => () => {} }
}))
vi.mock('../context-menu/worktree-context-menu-delete-intent', () => ({
  runWorktreeContextMenuDeleteIntent: runIntent
}))
vi.mock('./delete-worktree-flow', () => ({ runWorktreeDelete: runDelete }))

import {
  requestActiveWorkspaceDelete,
  resolveActiveWorkspaceDeleteIntent,
  selectActiveWorkspaceDeleteIntent
} from './active-workspace-delete'
import {
  cancelWorkspaceDeleteConfirmation,
  getArmedWorkspaceDeleteIdentity
} from './workspace-delete-confirmation'

const active = { ...worktree, id: 'a', instanceId: 'inc-a', hostId: 'local' as const }
const other = { ...worktree, id: 'b', instanceId: 'inc-b', hostId: 'local' as const }
const intent = {
  kind: 'worktree' as const,
  worktree: { id: 'a', instanceId: 'inc-a', hostId: 'local' as const }
}
const identity = getWorktreeHostIdentity(active)

beforeEach(() => {
  store = createUIStore()
  store.setState({
    activeView: 'terminal',
    activeWorktreeId: 'a',
    activeWorkspaceExecutionHostId: 'local',
    activeModal: 'none',
    activePendingCreationId: null,
    pendingWorktreeCreations: {},
    deleteStateByWorktreeId: {},
    repos: [repo],
    worktreesByRepo: { [repo.id]: [active, other] }
  })
})
afterEach(() => {
  cancelWorkspaceDeleteConfirmation()
  vi.clearAllMocks()
  document.body.innerHTML = ''
})

describe('active workspace delete target', () => {
  it('targets the open workspace, not any other row', () => {
    expect(selectActiveWorkspaceDeleteIntent(store.getState())).toEqual(intent)
  })

  it('targets nothing for a primary checkout, a running delete, or a non-workspace view', () => {
    store.setState({ worktreesByRepo: { [repo.id]: [{ ...active, isMainWorktree: true }] } })
    expect(selectActiveWorkspaceDeleteIntent(store.getState())).toBeNull()
    store.setState({
      worktreesByRepo: { [repo.id]: [active] },
      deleteStateByWorktreeId: {
        a: { isDeleting: true, error: null, canForceDelete: false, forceDeleteReason: null }
      }
    })
    expect(selectActiveWorkspaceDeleteIntent(store.getState())).toBeNull()
    store.setState({ deleteStateByWorktreeId: {}, activeView: 'settings' })
    expect(selectActiveWorkspaceDeleteIntent(store.getState())).toBeNull()
  })

  it('leaves the chord alone while a modal is open', () => {
    store.setState({ activeModal: 'quick-open' })
    expect(resolveActiveWorkspaceDeleteIntent(store.getState())).toBeNull()
  })

  it('targets an open folder workspace by its own route and host', () => {
    const folder = makeFolderWorkspace({ projectGroupId: MIXED_GROUP.id })
    store.setState({
      folderWorkspaces: [folder],
      projectGroups: [MIXED_GROUP],
      activeWorktreeId: `folder:${folder.id}`
    })
    expect(selectActiveWorkspaceDeleteIntent(store.getState())).toEqual({
      kind: 'folder',
      folderWorkspaceId: folder.id,
      executionHostId: 'local'
    })
  })
})

describe('requestActiveWorkspaceDelete', () => {
  const deferred: (() => void)[] = []
  const defer = (callback: () => void) => deferred.push(callback)
  const flush = () => deferred.splice(0).forEach((callback) => callback())
  const showPrompt = () => {
    document.body.innerHTML = `<div data-workspace-delete-confirm="${identity}"></div>`
  }

  it('arms on the first press and deletes on a second press while the row shows the prompt', () => {
    requestActiveWorkspaceDelete(intent, defer)
    showPrompt()
    flush()
    expect(getArmedWorkspaceDeleteIdentity()).toBe(identity)
    expect(runIntent).not.toHaveBeenCalled()
    requestActiveWorkspaceDelete(intent, defer)
    expect(runIntent).toHaveBeenCalledWith(intent, { confirmed: true })
    expect(runDelete).not.toHaveBeenCalled()
  })

  it('opens the dialog, even with asking turned off, when the prompt cannot show', () => {
    requestActiveWorkspaceDelete(intent, defer)
    flush()
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
    expect(runDelete).toHaveBeenCalledWith('a', {
      alwaysAsk: true,
      expectedInstanceId: 'inc-a',
      expectedHostId: 'local'
    })
    expect(runIntent).not.toHaveBeenCalled()
  })

  it('never removes an unseen folder', () => {
    requestActiveWorkspaceDelete(
      { kind: 'folder', folderWorkspaceId: 'notes', executionHostId: 'local' },
      defer
    )
    flush()
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
    expect(runDelete).not.toHaveBeenCalled()
    expect(runIntent).not.toHaveBeenCalled()
  })
})
