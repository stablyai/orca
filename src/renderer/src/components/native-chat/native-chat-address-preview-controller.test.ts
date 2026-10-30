import { describe, expect, it, vi } from 'vitest'
import type { ChatAddressPreviewResult } from '../../../../shared/chat-address-preview'
import { createAddressPreviewController } from './native-chat-address-preview-controller'

function deferredPreview() {
  let resolve!: (result: ChatAddressPreviewResult) => void
  const promise = new Promise<ChatAddressPreviewResult>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

const source = 'https://example.com/recording.wav'

describe('composer address preview ownership', () => {
  it('does not inspect restored or typed drafts until a successful paste admits the address', () => {
    const open = vi.fn()
    const controller = createAddressPreviewController(
      { open, release: vi.fn().mockResolvedValue(undefined) },
      () => source
    )
    controller.activate()
    controller.reconcile(source)
    expect(controller.getSnapshot()).toEqual([])
    expect(open).not.toHaveBeenCalled()
  })

  it('removes a preview on undo and never resurrects it when the read finishes late', async () => {
    const pending = deferredPreview()
    let draft = source
    const release = vi.fn().mockResolvedValue(undefined)
    const controller = createAddressPreviewController(
      { open: () => pending.promise, release },
      () => draft
    )
    controller.activate()
    controller.pasted(source)
    const [{ id }] = controller.getSnapshot()
    draft = ''
    controller.reconcile(draft)
    expect(controller.getSnapshot()).toEqual([])
    expect(release).toHaveBeenCalledWith(id)
    pending.resolve({
      status: 'ready',
      id,
      name: 'recording.wav',
      kind: 'audio',
      mimeType: 'audio/wav',
      url: 'orca-chat-preview://file/old'
    })
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(controller.getSnapshot()).toEqual([])
  })

  it('keeps an explicitly permitted retry separate from the canceled resource', async () => {
    const original = deferredPreview()
    const replacement = deferredPreview()
    const open = vi
      .fn()
      .mockImplementationOnce(() => original.promise)
      .mockImplementationOnce(() => replacement.promise)
    const release = vi.fn().mockResolvedValue(undefined)
    const controller = createAddressPreviewController({ open, release }, () => source)
    controller.activate()
    controller.pasted(source)
    const [{ id: oldId }] = controller.getSnapshot()
    controller.retry(oldId, true)
    const [{ id: newId }] = controller.getSnapshot()
    expect(newId).not.toBe(oldId)
    expect(open).toHaveBeenLastCalledWith({ id: newId, source, allowPrivateNetwork: true })
    original.resolve({ status: 'error', id: oldId, message: 'Canceled' })
    const ready: ChatAddressPreviewResult = {
      status: 'ready',
      id: newId,
      name: 'recording.wav',
      kind: 'audio',
      mimeType: 'audio/wav',
      url: 'orca-chat-preview://file/new'
    }
    replacement.resolve(ready)
    await vi.waitFor(() =>
      expect(controller.getSnapshot()).toEqual([{ id: newId, source, result: ready }])
    )
    expect(release).not.toHaveBeenCalledWith(newId)
  })

  it('retires all resources when a composer leaves its session', async () => {
    const pending = deferredPreview()
    const release = vi.fn().mockResolvedValue(undefined)
    const controller = createAddressPreviewController(
      { open: () => pending.promise, release },
      () => source
    )
    controller.activate()
    controller.pasted(source)
    const [{ id }] = controller.getSnapshot()
    controller.dispose()
    pending.resolve({ status: 'permission-required', id, message: 'Private network' })
    await vi.waitFor(() => expect(release).toHaveBeenCalledTimes(2))
    expect(controller.getSnapshot()).toEqual([])
    controller.pasted(source)
    expect(controller.getSnapshot()).toEqual([])
  })
})
