import { describe, expect, it } from 'vitest'
import {
  resolveWorkspaceKanbanPointerDragSelection,
  shouldStartWorkspaceKanbanCardPointerDrag
} from './use-workspace-kanban-card-pointer-drag'
import { makeWorktree } from '../../store/slices/store-test-helpers'

function pointerEvent(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return {
    button: 0,
    ctrlKey: false,
    metaKey: false,
    pointerType: 'mouse',
    shiftKey: false,
    ...overrides
  } as PointerEvent
}

describe('workspace kanban card pointer drag start', () => {
  it('starts for plain primary mouse drags', () => {
    expect(shouldStartWorkspaceKanbanCardPointerDrag(pointerEvent())).toBe(true)
  })

  it('does not steal modifier gestures from selection', () => {
    expect(shouldStartWorkspaceKanbanCardPointerDrag(pointerEvent({ metaKey: true }))).toBe(false)
    expect(shouldStartWorkspaceKanbanCardPointerDrag(pointerEvent({ ctrlKey: true }))).toBe(false)
    expect(shouldStartWorkspaceKanbanCardPointerDrag(pointerEvent({ shiftKey: true }))).toBe(false)
  })

  it('ignores touch and non-primary buttons', () => {
    expect(shouldStartWorkspaceKanbanCardPointerDrag(pointerEvent({ pointerType: 'touch' }))).toBe(
      false
    )
    expect(shouldStartWorkspaceKanbanCardPointerDrag(pointerEvent({ button: 1 }))).toBe(false)
  })
})

describe('workspace kanban pointer drag selection identity', () => {
  it('does not expand a same-id drag to the unselected host', () => {
    const local = makeWorktree({ id: 'shared', repoId: 'repo', hostId: 'local' })
    const remote = makeWorktree({ id: 'shared', repoId: 'repo', hostId: 'ssh:host-b' })

    expect(
      resolveWorkspaceKanbanPointerDragSelection({
        sourceWorktreeId: remote.id,
        sourceWorktreeIdentity: 'ssh:host-b|shared',
        selectedWorktreeIds: new Set(['local|shared']),
        selectedWorktrees: [local]
      })
    ).toEqual({
      worktreeIds: ['shared'],
      worktreeIdentities: ['ssh:host-b|shared']
    })
  })

  it('drags the selected host-qualified batch when the source row is selected', () => {
    const local = makeWorktree({ id: 'shared', repoId: 'repo', hostId: 'local' })
    const remote = makeWorktree({ id: 'shared', repoId: 'repo', hostId: 'ssh:host-b' })

    expect(
      resolveWorkspaceKanbanPointerDragSelection({
        sourceWorktreeId: remote.id,
        sourceWorktreeIdentity: 'ssh:host-b|shared',
        selectedWorktreeIds: new Set(['local|shared', 'ssh:host-b|shared']),
        selectedWorktrees: [local, remote]
      })
    ).toEqual({
      worktreeIds: ['shared', 'shared'],
      worktreeIdentities: ['local|shared', 'ssh:host-b|shared']
    })
  })
})
