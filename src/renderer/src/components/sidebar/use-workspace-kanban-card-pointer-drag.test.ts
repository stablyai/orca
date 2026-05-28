import { describe, expect, it } from 'vitest'
import { shouldStartWorkspaceKanbanCardPointerDrag } from './use-workspace-kanban-card-pointer-drag'

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
