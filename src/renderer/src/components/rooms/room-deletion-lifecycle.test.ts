import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeTabs: vi.fn(),
  reportError: vi.fn(),
  rpc: vi.fn(),
  toastSuccess: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { success: mocks.toastSuccess } }))
vi.mock('@/runtime/runtime-rooms-client', () => ({ roomRpc: mocks.rpc }))
vi.mock('./room-action-error', () => ({ showRoomActionError: mocks.reportError }))
vi.mock('./use-room-tabs', () => ({ closeRoomTabs: mocks.closeTabs }))

import { closeRoomTabsForEnd, deleteRoomFromUi } from './room-deletion-lifecycle'

describe('room deletion renderer lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.rpc.mockResolvedValue({ deleted: true })
  })

  it('does nothing when confirmation is cancelled', async () => {
    const setDeleting = vi.fn()

    await deleteRoomFromUi({
      room: { id: 'room-1', name: 'Research' },
      target: { kind: 'local' },
      confirm: vi.fn().mockResolvedValue(false),
      setDeleting
    })

    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.closeTabs).not.toHaveBeenCalled()
    expect(setDeleting).not.toHaveBeenCalled()
  })

  it('confirms, deletes, and closes every tab only after RPC success', async () => {
    const confirm = vi.fn().mockResolvedValue(true)
    const setDeleting = vi.fn()

    await deleteRoomFromUi({
      room: { id: 'room-1', name: 'Research' },
      target: { kind: 'local' },
      confirm,
      setDeleting
    })

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Delete “Research”?',
        confirmLabel: 'Delete room',
        confirmVariant: 'destructive'
      })
    )
    expect(setDeleting.mock.calls).toEqual([[true], [false]])
    expect(mocks.rpc).toHaveBeenCalledWith({ kind: 'local' }, 'rooms.delete', {
      roomId: 'room-1'
    })
    expect(mocks.closeTabs).toHaveBeenCalledWith('room-1')
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Room deleted')
  })

  it('keeps tabs open and restores the UI when deletion fails', async () => {
    const error = new Error('delete_failed')
    const setDeleting = vi.fn()
    mocks.rpc.mockRejectedValue(error)

    await deleteRoomFromUi({
      room: { id: 'room-1', name: 'Research' },
      target: { kind: 'local' },
      confirm: vi.fn().mockResolvedValue(true),
      setDeleting
    })

    expect(mocks.closeTabs).not.toHaveBeenCalled()
    expect(mocks.reportError).toHaveBeenCalledWith(error)
    expect(setDeleting.mock.calls).toEqual([[true], [false]])
  })

  it('closes tabs only for a deleted end event', () => {
    closeRoomTabsForEnd({ type: 'end' }, 'room-1')
    expect(mocks.closeTabs).not.toHaveBeenCalled()

    closeRoomTabsForEnd({ type: 'end', reason: 'deleted' }, 'room-1')
    expect(mocks.closeTabs).toHaveBeenCalledWith('room-1')
  })
})
