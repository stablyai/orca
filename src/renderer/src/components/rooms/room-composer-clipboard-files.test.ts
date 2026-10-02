import { describe, expect, it, vi } from 'vitest'
import { getRoomComposerClipboardFiles } from './room-composer-clipboard-files'

function transfer(
  files: File[],
  items: Parameters<typeof getRoomComposerClipboardFiles>[0]['items'] = []
) {
  return { files, items }
}

describe('getRoomComposerClipboardFiles', () => {
  it('reads an image clipboard item when the file list is empty', () => {
    const image = new File(['png'], '', { type: 'image/png' })
    const item = {
      kind: 'file',
      getAsFile: vi.fn(() => image),
      webkitGetAsEntry: vi.fn(() => ({ isDirectory: false }))
    }

    const [result] = getRoomComposerClipboardFiles(transfer([], [item]))

    expect(result?.name).toBe('pasted-file-1.png')
    expect(result?.type).toBe('image/png')
  })

  it('uses one source when clipboard items and files contain the same file', () => {
    const file = new File(['report'], 'report.pdf', { type: 'application/pdf' })
    const item = { kind: 'file', getAsFile: vi.fn(() => file) }

    expect(getRoomComposerClipboardFiles(transfer([file], [item]))).toEqual([file])
  })

  it('leaves text-only paste untouched', () => {
    const item = { kind: 'string', getAsFile: vi.fn() }
    expect(getRoomComposerClipboardFiles(transfer([], [item]))).toEqual([])
  })
})
