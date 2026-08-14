// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  downloadRoomAttachment: vi.fn(),
  readRoomAttachmentPreview: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('sonner', () => ({
  toast: { loading: vi.fn(), success: vi.fn(), dismiss: vi.fn(), error: vi.fn() }
}))
vi.mock('./room-attachment-transfer', () => ({
  downloadRoomAttachment: (...args: unknown[]) => mocks.downloadRoomAttachment(...args),
  readRoomAttachmentPreview: (...args: unknown[]) => mocks.readRoomAttachmentPreview(...args)
}))
vi.mock('./RoomImagePreviewDialog', () => ({
  RoomImagePreviewDialog: ({
    preview
  }: {
    preview: {
      fileName: string
      onDownload: () => void
      onPrevious?: () => void
      onNext?: () => void
    } | null
  }) =>
    preview ? (
      <div data-testid="room-image-viewer">
        {preview.fileName}
        <button onClick={preview.onDownload}>Download current</button>
        {preview.onPrevious ? <button onClick={preview.onPrevious}>Previous current</button> : null}
        {preview.onNext ? <button onClick={preview.onNext}>Next current</button> : null}
      </div>
    ) : null
}))

import { RoomComposerAttachments, RoomMessageAttachments } from './RoomAttachments'

describe('RoomComposerAttachments image viewer', () => {
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    mocks.downloadRoomAttachment.mockReset()
    mocks.readRoomAttachmentPreview.mockReset()
  })

  it('opens, navigates, and downloads the selected room image', () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
    render(
      <RoomComposerAttachments
        attachments={[
          {
            uploadId: 'one',
            fileName: 'one.png',
            byteSize: 10,
            mimeType: 'image/png',
            previewUrl: 'blob:one'
          },
          {
            uploadId: 'two',
            fileName: 'two.png',
            byteSize: 20,
            mimeType: 'image/png',
            previewUrl: 'blob:two'
          }
        ]}
        uploading={null}
        onRemove={vi.fn()}
        onCancelUpload={vi.fn()}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: 'two.png' }))
    expect(screen.getByTestId('room-image-viewer').textContent).toContain('two.png')
    fireEvent.click(screen.getByRole('button', { name: 'Previous current' }))
    expect(screen.getByTestId('room-image-viewer').textContent).toContain('one.png')
    fireEvent.click(screen.getByRole('button', { name: 'Download current' }))
    expect(anchorClick).toHaveBeenCalledOnce()
  })

  it('opens a downloaded room-message preview and preserves its download action', async () => {
    mocks.readRoomAttachmentPreview.mockResolvedValue({
      mimeType: 'image/png',
      contentBase64: 'aGVsbG8='
    })
    mocks.downloadRoomAttachment.mockResolvedValue('/tmp/image.png')
    render(
      <RoomMessageAttachments
        data={{ target: { kind: 'local' } } as never}
        message={{
          id: 'message-1',
          roomId: 'room-1',
          sequence: 1,
          senderId: 'user-1',
          senderIdentity: 'user',
          actorKind: 'user',
          kind: 'chat',
          body: '',
          replyToId: null,
          rootMessageId: null,
          hopCount: 0,
          metadata: {},
          mentions: [],
          attachments: [
            {
              id: 'image-1',
              messageId: 'message-1',
              fileName: 'image.png',
              mimeType: 'image/png',
              byteSize: 5,
              localPath: '/room/image.png',
              createdAt: 1
            }
          ],
          createdAt: 1,
          editedAt: null,
          deletedAt: null
        }}
      />
    )

    fireEvent.click(await screen.findByRole('button', { name: 'image.png' }))
    expect(screen.getByTestId('room-image-viewer').textContent).toContain('image.png')
    fireEvent.click(screen.getByRole('button', { name: 'Download current' }))
    await waitFor(() => expect(mocks.downloadRoomAttachment).toHaveBeenCalledOnce())
  })
})
