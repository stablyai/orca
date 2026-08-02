import { describe, expect, it, vi } from 'vitest'
import {
  WORKSPACE_STATUS_DRAG_ID_MAX_COUNT,
  WORKSPACE_STATUS_DRAG_IDS_TYPE,
  WORKSPACE_STATUS_DRAG_PAYLOAD_MAX_BYTES,
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

  it('ignores invalid decoded worktree ids while preserving valid batch ids', () => {
    const dataTransfer = new TestDataTransfer() as unknown as DataTransfer
    dataTransfer.setData(
      WORKSPACE_STATUS_DRAG_IDS_TYPE,
      JSON.stringify(['wt-1', null, '', 7, 'wt-2'])
    )

    expect(readWorkspaceDragDataIds(dataTransfer)).toEqual(['wt-1', 'wt-2'])
  })

  it('ignores oversized plain-text workspace drag fallbacks', () => {
    const dataTransfer = new TestDataTransfer() as unknown as DataTransfer
    const secret = 'workspace-drag-secret'
    dataTransfer.setData('text/plain', secret + 'x'.repeat(WORKSPACE_STATUS_DRAG_PAYLOAD_MAX_BYTES))

    expect(readWorkspaceDragData(dataTransfer)).toBeNull()
    expect(readWorkspaceDragDataIds(dataTransfer)).toEqual([])
    expect(hasWorkspaceDragData(dataTransfer)).toBe(false)
  })

  it('ignores multibyte oversized workspace drag fallbacks', () => {
    const dataTransfer = new TestDataTransfer() as unknown as DataTransfer
    dataTransfer.setData('text/plain', '😀'.repeat(4097))

    expect(readWorkspaceDragData(dataTransfer)).toBeNull()
    expect(readWorkspaceDragDataIds(dataTransfer)).toEqual([])
    expect(hasWorkspaceDragData(dataTransfer)).toBe(false)
  })

  it('does not fall back to plain text when the typed id batch is oversized', () => {
    const dataTransfer = new TestDataTransfer() as unknown as DataTransfer
    dataTransfer.setData(
      WORKSPACE_STATUS_DRAG_IDS_TYPE,
      JSON.stringify(['wt-1']) + 'x'.repeat(WORKSPACE_STATUS_DRAG_PAYLOAD_MAX_BYTES)
    )
    dataTransfer.setData('text/plain', 'wt-fallback')

    expect(readWorkspaceDragDataIds(dataTransfer)).toEqual([])
  })

  it('rejects oversized selected worktree id batches', () => {
    const dataTransfer = new TestDataTransfer() as unknown as DataTransfer
    dataTransfer.setData(
      WORKSPACE_STATUS_DRAG_IDS_TYPE,
      JSON.stringify(
        Array.from({ length: WORKSPACE_STATUS_DRAG_ID_MAX_COUNT + 1 }, (_value, index) =>
          String(index)
        )
      )
    )

    const filterSpy = vi.spyOn(Array.prototype, 'filter')
    const result = readWorkspaceDragDataIds(dataTransfer)
    const filterCallCount = filterSpy.mock.calls.length
    filterSpy.mockRestore()

    expect(result).toEqual([])
    expect(filterCallCount).toBe(0)
  })
})
