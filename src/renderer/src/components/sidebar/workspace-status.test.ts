import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_STATUS_DRAG_IDS_TYPE,
  WORKSPACE_STATUS_DRAG_TYPE,
  hasWorkspaceDragData,
  readWorkspaceDragData,
  readWorkspaceDragDataIds,
  writeWorkspaceDragData
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

describe('workspace status drag data', () => {
  it('keeps the legacy single worktree payload when writing a selected batch', () => {
    const dataTransfer = new TestDataTransfer() as unknown as DataTransfer

    writeWorkspaceDragData(dataTransfer, ['wt-1', 'wt-2', 'wt-3'])

    expect(dataTransfer.effectAllowed).toBe('move')
    expect(dataTransfer.getData(WORKSPACE_STATUS_DRAG_TYPE)).toBe('wt-1')
    expect(dataTransfer.getData('text/plain')).toBe('wt-1')
    expect(readWorkspaceDragData(dataTransfer)).toBe('wt-1')
  })

  it('round-trips selected worktree ids for board batch drops', () => {
    const dataTransfer = new TestDataTransfer() as unknown as DataTransfer

    writeWorkspaceDragData(dataTransfer, ['wt-1', 'wt-2'])

    expect(dataTransfer.getData(WORKSPACE_STATUS_DRAG_IDS_TYPE)).toBe('["wt-1","wt-2"]')
    expect(readWorkspaceDragDataIds(dataTransfer)).toEqual(['wt-1', 'wt-2'])
    expect(hasWorkspaceDragData(dataTransfer)).toBe(true)
  })

  it('falls back to the single worktree payload for older drag sources', () => {
    const dataTransfer = new TestDataTransfer() as unknown as DataTransfer
    dataTransfer.setData(WORKSPACE_STATUS_DRAG_TYPE, 'wt-1')

    expect(readWorkspaceDragDataIds(dataTransfer)).toEqual(['wt-1'])
    expect(hasWorkspaceDragData(dataTransfer)).toBe(true)
  })
})
