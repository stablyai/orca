// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'

const runIntent = vi.hoisted(() => vi.fn())
vi.mock('@/store', () => ({ useAppStore: { subscribe: () => () => {} } }))
vi.mock('../../workspace-actions/context-menu/worktree-context-menu-delete-intent', () => ({
  runWorktreeContextMenuDeleteIntent: runIntent
}))

import { requestSidebarWorkspaceDelete } from './use-sidebar-workspace-delete-keyboard'
import {
  cancelWorkspaceDeleteConfirmation,
  getArmedWorkspaceDeleteIdentity
} from '../../workspace-actions/deletion/workspace-delete-confirmation'
import { getWorktreeHostIdentity } from '../../../../../../shared/worktree/host-qualified-identity'

const worktree = { id: 'repo::/a', instanceId: 'inc-a', hostId: 'local' as const }
const intent = { kind: 'worktree' as const, worktree }
const identity = getWorktreeHostIdentity(worktree)

function showPrompt(forIdentity: string, hidden = false): void {
  document.body.innerHTML = `<div ${hidden ? 'aria-hidden="true"' : ''}><div data-workspace-delete-confirm="${forIdentity}"></div></div>`
}

describe('requestSidebarWorkspaceDelete', () => {
  afterEach(() => {
    cancelWorkspaceDeleteConfirmation()
    runIntent.mockReset()
    document.body.innerHTML = ''
  })

  it('arms on the first press and deletes confirmed on the second', () => {
    requestSidebarWorkspaceDelete(intent)
    expect(runIntent).not.toHaveBeenCalled()
    expect(getArmedWorkspaceDeleteIdentity()).toBe(identity)
    showPrompt(identity)
    requestSidebarWorkspaceDelete(intent)
    expect(runIntent).toHaveBeenCalledWith(intent, { confirmed: true })
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
  })

  it('re-arms instead of deleting when the prompt is not on screen', () => {
    requestSidebarWorkspaceDelete(intent)
    showPrompt(identity, true)
    requestSidebarWorkspaceDelete(intent)
    expect(runIntent).not.toHaveBeenCalled()
    expect(getArmedWorkspaceDeleteIdentity()).toBe(identity)
  })

  it('arms the new row when the selection moved', () => {
    requestSidebarWorkspaceDelete(intent)
    showPrompt(identity)
    const other = { ...worktree, id: 'repo::/b' }
    requestSidebarWorkspaceDelete({ kind: 'worktree', worktree: other })
    expect(runIntent).not.toHaveBeenCalled()
    expect(getArmedWorkspaceDeleteIdentity()).toBe(getWorktreeHostIdentity(other))
  })

  it('arms folder rows by their workspace key', () => {
    requestSidebarWorkspaceDelete({
      kind: 'folder',
      folderWorkspaceId: 'f',
      executionHostId: 'local'
    })
    expect(getArmedWorkspaceDeleteIdentity()).toBe(
      getWorktreeHostIdentity({ id: 'folder:f', hostId: 'local' })
    )
  })

  it('keeps the batch dialog on the first press', () => {
    const batch = { kind: 'batch' as const, worktrees: [worktree] }
    requestSidebarWorkspaceDelete(batch)
    expect(runIntent).toHaveBeenCalledWith(batch)
    expect(getArmedWorkspaceDeleteIdentity()).toBeNull()
  })
})
