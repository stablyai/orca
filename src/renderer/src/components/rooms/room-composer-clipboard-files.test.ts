import { describe, expect, it, vi } from 'vitest'
import { getRoomComposerClipboardFiles } from './room-composer-clipboard-files'

function transfer(files: File[], items: DataTransferItem[] = []): DataTransfer {
  return { files, items } as unknown as DataTransfer
}

describe('getRoomComposerClipboardFiles', () => {
  it('reads an image clipboard item when the file list is empty', () => {
    const image = new File(['png'], '', { type: 'image/png' })
    const item = {
      kind: 'file',
      getAsFile: vi.fn(() => image),
      webkitGetAsEntry: vi.fn(() => ({ isDirectory: false }))
    } as unknown as DataTransferItem

    const [result] = getRoomComposerClipboardFiles(transfer([], [item]))

    expect(result?.name).toBe('pasted-file-1.png')
    expect(result?.type).toBe('image/png')
  })

  it('uses one source when clipboard items and files contain the same file', () => {
    const file = new File(['report'], 'report.pdf', { type: 'application/pdf' })
    const item = { kind: 'file', getAsFile: vi.fn(() => file) } as unknown as DataTransferItem

    expect(getRoomComposerClipboardFiles(transfer([file], [item]))).toEqual([file])
  })

  it('leaves text-only paste untouched', () => {
    const item = { kind: 'string', getAsFile: vi.fn() } as unknown as DataTransferItem
    expect(getRoomComposerClipboardFiles(transfer([], [item]))).toEqual([])
  })
})
