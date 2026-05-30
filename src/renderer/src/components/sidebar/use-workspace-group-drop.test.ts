import { describe, it, expect, vi } from 'vitest'
import {
  writeWorkspaceDragData,
  readWorkspaceDragDataIds,
  hasWorkspaceDragData
} from './workspace-status'

class TestDataTransfer {
  effectAllowed = 'uninitialized'
  private readonly values = new Map<string, string>()

  get types(): string[] {
    return [...this.values.keys()]
  }

  getData(type: string): string {
    return this.values.get(type) ?? ''
  }

  setData(type: string, value: string): void {
    this.values.set(type, value)
  }
}

function makeDataTransfer(ids: string[]): DataTransfer {
  const dt = new TestDataTransfer() as unknown as DataTransfer
  writeWorkspaceDragData(dt, ids)
  return dt
}

function makeEvent(ids: string[]): React.DragEvent {
  return {
    preventDefault: vi.fn(),
    dataTransfer: makeDataTransfer(ids)
  } as unknown as React.DragEvent
}

describe('useWorkspaceGroupDrop', () => {
  it('invokes onAssign with the dropped worktree ids and the bound groupId', () => {
    const onAssign = vi.fn()
    const groupId = 'wg_target'
    const e = makeEvent(['wt1', 'wt2'])

    if (!hasWorkspaceDragData(e.dataTransfer)) {
      return
    }
    e.preventDefault()
    const ids = readWorkspaceDragDataIds(e.dataTransfer)
    if (ids.length > 0) {
      onAssign(ids, groupId)
    }

    expect(onAssign).toHaveBeenCalledWith(['wt1', 'wt2'], 'wg_target')
  })

  it('passes null groupId for Ungrouped target', () => {
    const onAssign = vi.fn()
    const e = makeEvent(['wt9'])

    if (!hasWorkspaceDragData(e.dataTransfer)) {
      return
    }
    e.preventDefault()
    const ids = readWorkspaceDragDataIds(e.dataTransfer)
    if (ids.length > 0) {
      onAssign(ids, null)
    }

    expect(onAssign).toHaveBeenCalledWith(['wt9'], null)
  })

  it('ignores drops without workspace drag data', () => {
    const onAssign = vi.fn()
    const dt = new TestDataTransfer() as unknown as DataTransfer
    const e = { preventDefault: vi.fn(), dataTransfer: dt } as unknown as React.DragEvent

    if (hasWorkspaceDragData(e.dataTransfer)) {
      const ids = readWorkspaceDragDataIds(e.dataTransfer)
      if (ids.length > 0) {
        onAssign(ids, 'wg_x')
      }
    }

    expect(onAssign).not.toHaveBeenCalled()
  })
})
