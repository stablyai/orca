import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockCallRuntimeRpc = vi.fn()
const mockGetActiveRuntimeTarget = vi.fn()

vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: (...args: unknown[]) => mockCallRuntimeRpc(...args),
  getActiveRuntimeTarget: (...args: unknown[]) => mockGetActiveRuntimeTarget(...args)
}))

import {
  trelloUploadAttachment,
  trelloDownloadImage,
  trelloStatus,
  trelloConnect,
  trelloCreateCard
} from './runtime-trello-client'

const trelloUploadAttachmentLocal = vi.fn()
const trelloDownloadImageLocal = vi.fn()
const trelloStatusLocal = vi.fn()
const trelloConnectLocal = vi.fn()
const trelloCreateCardLocal = vi.fn()
const trelloListBoardsLocal = vi.fn()

beforeEach(() => {
  mockCallRuntimeRpc.mockReset()
  mockGetActiveRuntimeTarget.mockReset()
  trelloUploadAttachmentLocal.mockReset()
  trelloDownloadImageLocal.mockReset()
  trelloStatusLocal.mockReset()
  trelloConnectLocal.mockReset()
  trelloCreateCardLocal.mockReset()
  trelloListBoardsLocal.mockReset()

  vi.stubGlobal('window', {
    api: {
      trello: {
        uploadAttachment: trelloUploadAttachmentLocal,
        downloadImage: trelloDownloadImageLocal,
        status: trelloStatusLocal,
        connect: trelloConnectLocal,
        createCard: trelloCreateCardLocal,
        listBoards: trelloListBoardsLocal
      }
    }
  })
})

describe('runtime trello client', () => {
  describe('local path', () => {
    it('trelloUploadAttachment calls window.api.trello for local', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
      trelloUploadAttachmentLocal.mockResolvedValue({
        ok: true,
        attachment: {
          id: 'att-1',
          name: 'test.png',
          fileName: 'test.png',
          mimeType: 'image/png',
          url: 'https://trello.com/att'
        }
      })

      const result = await trelloUploadAttachment(null, {
        cardId: 'card-1',
        name: 'test.png',
        mimeType: 'image/png',
        contentBase64: 'AAAA'
      })

      expect(trelloUploadAttachmentLocal).toHaveBeenCalledWith({
        cardId: 'card-1',
        name: 'test.png',
        mimeType: 'image/png',
        contentBase64: 'AAAA'
      })
      expect(mockCallRuntimeRpc).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
    })

    it('trelloDownloadImage calls window.api.trello for local', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
      trelloDownloadImageLocal.mockResolvedValue({
        ok: true,
        contentType: 'image/png',
        contentBase64: 'AAAA'
      })

      const result = await trelloDownloadImage(null, 'https://trello.com/image.png')

      expect(trelloDownloadImageLocal).toHaveBeenCalledWith({ url: 'https://trello.com/image.png' })
      expect(mockCallRuntimeRpc).not.toHaveBeenCalled()
      expect(result).toEqual({ ok: true, contentType: 'image/png', contentBase64: 'AAAA' })
    })

    it('trelloStatus calls window.api.trello for local', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
      trelloStatusLocal.mockResolvedValue({ connected: true, viewer: null })

      const result = await trelloStatus(null)

      expect(trelloStatusLocal).toHaveBeenCalled()
      expect(mockCallRuntimeRpc).not.toHaveBeenCalled()
      expect(result).toEqual({ connected: true, viewer: null })
    })

    it('trelloConnect calls window.api.trello for local', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
      trelloConnectLocal.mockResolvedValue({
        ok: true,
        viewer: { id: 'u1', username: 'test', displayName: 'Test' }
      })

      const result = await trelloConnect(null, { apiKey: 'k', token: 't' })

      expect(trelloConnectLocal).toHaveBeenCalledWith({ apiKey: 'k', token: 't' })
      expect(mockCallRuntimeRpc).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
    })

    it('trelloCreateCard calls window.api.trello for local', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'local' })
      trelloCreateCardLocal.mockResolvedValue({
        ok: true,
        id: 'c1',
        shortLink: 'sl',
        url: 'https://trello.com/c/c1'
      })

      const result = await trelloCreateCard(null, { idBoard: 'b1', idList: 'l1', name: 'Card' })

      expect(trelloCreateCardLocal).toHaveBeenCalledWith({
        idBoard: 'b1',
        idList: 'l1',
        name: 'Card'
      })
      expect(mockCallRuntimeRpc).not.toHaveBeenCalled()
      expect(result.ok).toBe(true)
    })
  })

  describe('remote upload uses chunked transfer', () => {
    it('does not call trello.uploadAttachment RPC directly', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
      mockCallRuntimeRpc
        .mockResolvedValueOnce({ uploadId: 'upload-1' }) // startUpload
        .mockResolvedValueOnce({ receivedBase64Length: 4 }) // appendUploadChunk
        .mockResolvedValueOnce({
          // commitUpload
          ok: true,
          attachment: {
            id: 'att-1',
            name: 'test.png',
            fileName: 'test.png',
            mimeType: 'image/png',
            url: 'https://trello.com/att'
          }
        })

      const result = await trelloUploadAttachment(
        { activeRuntimeEnvironmentId: 'env-1' },
        { cardId: 'card-1', name: 'test.png', mimeType: 'image/png', contentBase64: 'AAAA' }
      )

      expect(result.ok).toBe(true)

      const calls = mockCallRuntimeRpc.mock.calls.map((c: unknown[]) => c[1])
      expect(calls).toContain('trello.startUpload')
      expect(calls).toContain('trello.appendUploadChunk')
      expect(calls).toContain('trello.commitUpload')
      expect(calls).not.toContain('trello.uploadAttachment')

      // Verify startUpload was called with metadata, not full content
      const startCall = mockCallRuntimeRpc.mock.calls[0]
      expect(startCall[2]).toEqual({
        cardId: 'card-1',
        name: 'test.png',
        mimeType: 'image/png',
        expectedBase64Length: 4
      })
    })

    it('aborts on error', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
      mockCallRuntimeRpc
        .mockResolvedValueOnce({ uploadId: 'upload-1' }) // startUpload
        .mockRejectedValueOnce(new Error('network error')) // appendUploadChunk
        .mockResolvedValueOnce({ aborted: true }) // abortUpload

      const result = await trelloUploadAttachment(
        { activeRuntimeEnvironmentId: 'env-1' },
        { cardId: 'card-1', name: 'test.png', mimeType: 'image/png', contentBase64: 'AAAA' }
      )

      expect(result.ok).toBe(false)
      const calls = mockCallRuntimeRpc.mock.calls.map((c: unknown[]) => c[1])
      expect(calls).toContain('trello.abortUpload')
    })
    it('trims cardId and name before sending to runtime', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
      mockCallRuntimeRpc
        .mockResolvedValueOnce({ uploadId: 'upload-1' }) // startUpload
        .mockResolvedValueOnce({ receivedBase64Length: 4 }) // appendUploadChunk
        .mockResolvedValueOnce({
          ok: true,
          attachment: {
            id: 'att-1',
            name: 'test.png',
            fileName: 'test.png',
            mimeType: 'image/png',
            url: 'https://trello.com/att'
          }
        })

      await trelloUploadAttachment(
        { activeRuntimeEnvironmentId: 'env-1' },
        {
          cardId: '  card-1  ',
          name: '  test.png  ',
          mimeType: 'image/png',
          contentBase64: 'AAAA'
        }
      )

      const startCall = mockCallRuntimeRpc.mock.calls[0]
      expect(startCall[2]).toEqual({
        cardId: 'card-1',
        name: 'test.png',
        mimeType: 'image/png',
        expectedBase64Length: 4
      })
    })
  })

  describe('remote download uses chunked transfer', () => {
    it('reads chunks instead of getting full content in one call', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
      mockCallRuntimeRpc
        .mockResolvedValueOnce({
          // startDownload
          downloadId: 'dl-1',
          contentType: 'image/png',
          totalBase64Length: 8,
          chunkSize: 4
        })
        .mockResolvedValueOnce({ contentBase64: 'AAAA' }) // readDownloadChunk 0..4
        .mockResolvedValueOnce({ contentBase64: 'BBBB' }) // readDownloadChunk 4..8
        .mockResolvedValueOnce({ aborted: true }) // abortDownload

      const result = await trelloDownloadImage(
        { activeRuntimeEnvironmentId: 'env-1' },
        'https://trello.com/image.png'
      )

      expect(result).toEqual({ ok: true, contentType: 'image/png', contentBase64: 'AAAABBBB' })

      const calls = mockCallRuntimeRpc.mock.calls.map((c: unknown[]) => c[1])
      expect(calls).toContain('trello.startDownload')
      expect(calls).toContain('trello.readDownloadChunk')
      expect(calls).toContain('trello.abortDownload')
      expect(calls).not.toContain('trello.downloadImage')
    })

    it('returns error on download failure', async () => {
      mockGetActiveRuntimeTarget.mockReturnValue({ kind: 'environment', environmentId: 'env-1' })
      mockCallRuntimeRpc.mockRejectedValue(new Error('download failed'))

      const result = await trelloDownloadImage(
        { activeRuntimeEnvironmentId: 'env-1' },
        'https://trello.com/image.png'
      )

      expect(result).toEqual({ ok: false, error: 'download failed' })
    })
  })
})
