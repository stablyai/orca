import { describe, expect, it, vi } from 'vitest'
import { applyComposerNativeFileDrop } from './composer-native-file-drop'

function createDropArgs() {
  return {
    paths: ['/local/a.txt'],
    isCurrentOwner: vi.fn(() => true),
    uploadPaths: vi.fn(),
    applyLocalPaths: vi.fn().mockResolvedValue(undefined),
    addAttachments: vi.fn(),
    insertFolderPaths: vi.fn(),
    onError: vi.fn()
  }
}

describe('applyComposerNativeFileDrop', () => {
  it('reports upload owner failures without falling through to client-local paths', async () => {
    const args = createDropArgs()
    const error = new Error('Attachment upload host changed; retry the upload.')
    args.uploadPaths.mockRejectedValue(error)

    await applyComposerNativeFileDrop(args)

    expect(args.onError).toHaveBeenCalledWith(error)
    expect(args.applyLocalPaths).not.toHaveBeenCalled()
    expect(args.addAttachments).not.toHaveBeenCalled()
  })

  it('does not surface a failure after the composer loses drop ownership', async () => {
    const args = createDropArgs()
    args.uploadPaths.mockRejectedValue(new Error('stale owner'))
    args.isCurrentOwner.mockReturnValue(false)

    await applyComposerNativeFileDrop(args)

    expect(args.onError).not.toHaveBeenCalled()
    expect(args.applyLocalPaths).not.toHaveBeenCalled()
  })

  it('applies local paths when no remote upload route is needed', async () => {
    const args = createDropArgs()
    args.uploadPaths.mockResolvedValue(null)

    await applyComposerNativeFileDrop(args)

    expect(args.applyLocalPaths).toHaveBeenCalledWith(args.paths, args.isCurrentOwner)
    expect(args.addAttachments).not.toHaveBeenCalled()
    expect(args.insertFolderPaths).not.toHaveBeenCalled()
    expect(args.onError).not.toHaveBeenCalled()
  })

  it('applies uploaded files and folders only while the composer still owns the drop', async () => {
    const args = createDropArgs()
    args.uploadPaths.mockResolvedValue({
      filePaths: ['/remote/a.txt'],
      folderPaths: ['/remote/folder']
    })

    await applyComposerNativeFileDrop(args)

    expect(args.addAttachments).toHaveBeenCalledWith(['/remote/a.txt'])
    expect(args.insertFolderPaths).toHaveBeenCalledWith(['/remote/folder'])
    expect(args.applyLocalPaths).not.toHaveBeenCalled()
    expect(args.onError).not.toHaveBeenCalled()
  })

  it('discards uploaded paths after the composer loses drop ownership', async () => {
    const args = createDropArgs()
    args.uploadPaths.mockResolvedValue({
      filePaths: ['/remote/a.txt'],
      folderPaths: ['/remote/folder']
    })
    args.isCurrentOwner.mockReturnValue(false)

    await applyComposerNativeFileDrop(args)

    expect(args.addAttachments).not.toHaveBeenCalled()
    expect(args.insertFolderPaths).not.toHaveBeenCalled()
    expect(args.applyLocalPaths).not.toHaveBeenCalled()
    expect(args.onError).not.toHaveBeenCalled()
  })
})
