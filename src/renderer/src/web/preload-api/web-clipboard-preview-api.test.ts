import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({
  call: vi.fn(async () => ({ ok: true })),
  owner: vi.fn(() => ({ id: 'original-runtime' })),
  read: vi.fn(async () => 'cG5n'),
  save: vi.fn(async () => '/tmp/same-name.png')
}))
vi.mock('./web-runtime-calls', () => ({ callEnvironmentEnvelope: mocks.call }))
vi.mock('./web-runtime-session', () => ({ requireActiveEnvironmentOrNull: mocks.owner }))
vi.mock('./web-clipboard-api', () => ({
  readClipboardImagePngBase64: mocks.read,
  saveClipboardImageAsTempFileInRuntime: mocks.save
}))
import { createWebClipboardPreviewApi } from './web-clipboard-preview-api'
beforeEach(() => vi.clearAllMocks())
describe('browser clipboard preview ownership', () => {
  it('keeps the resolved owner when active runtime changes before settlement', async () => {
    const api = createWebClipboardPreviewApi()
    const preview = await api.saveClipboardImagePreview({ runtimeEnvironmentId: null })
    expect(preview).toEqual({
      path: '/tmp/same-name.png',
      dataUrl: 'data:image/png;base64,cG5n',
      runtimeEnvironmentId: 'original-runtime'
    })
    mocks.owner.mockReturnValueOnce({ id: 'different-runtime' })
    if (!preview) {
      throw new Error('No preview')
    }
    await api.settleClipboardImagePreview({
      path: preview.path,
      runtimeEnvironmentId: preview.runtimeEnvironmentId
    })
    expect(mocks.call).toHaveBeenLastCalledWith('original-runtime', 'clipboard.imageLease', {
      path: '/tmp/same-name.png',
      connectionId: undefined,
      retain: undefined,
      release: undefined
    })
    expect(mocks.save).toHaveBeenCalledWith('cG5n', {
      runtimeEnvironmentId: 'original-runtime',
      discardable: true
    })
  })
  it('refuses an unsupported runtime before any image upload', async () => {
    mocks.call.mockResolvedValueOnce({ ok: false })
    await expect(
      createWebClipboardPreviewApi().saveClipboardImagePreview({
        runtimeEnvironmentId: 'old-runtime'
      })
    ).rejects.toThrow('Update the remote Orca server')
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
