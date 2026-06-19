import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clipboardHasImage, handleRichMarkdownImagePaste } from './rich-markdown-paste-image'
import { insertRichMarkdownImageFromPath } from './rich-markdown-image-insert'

vi.mock('./rich-markdown-image-insert', () => ({
  insertRichMarkdownImageFromPath: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => 'ssh-1')
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: vi.fn(() => ({
      settings: { activeRuntimeEnvironmentId: null }
    }))
  }
}))

vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: vi.fn((settings, runtimeEnvironmentId) =>
    runtimeEnvironmentId === null
      ? { activeRuntimeEnvironmentId: null }
      : runtimeEnvironmentId
        ? { activeRuntimeEnvironmentId: runtimeEnvironmentId }
        : settings
  )
}))

vi.mock('sonner', () => ({
  toast: { error: vi.fn() }
}))

function pasteEvent(items: Partial<DataTransferItem>[]): ClipboardEvent {
  return {
    clipboardData: { items },
    preventDefault: vi.fn()
  } as unknown as ClipboardEvent
}

function editorAt(position: number) {
  return {
    state: { selection: { from: position } }
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('rich markdown image paste', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('window', {
      api: {
        ui: {
          saveClipboardImageAsTempFile: vi.fn().mockResolvedValue('/tmp/orca-paste-image.png')
        }
      }
    })
  })

  it('detects image files on the clipboard', () => {
    expect(
      clipboardHasImage(
        pasteEvent([
          { kind: 'string', type: 'text/plain' },
          { kind: 'file', type: 'image/png' }
        ])
      )
    ).toBe(true)
    expect(clipboardHasImage(pasteEvent([{ kind: 'string', type: 'text/plain' }]))).toBe(false)
  })

  it('imports pasted images instead of letting TipTap embed base64 markdown', async () => {
    const event = pasteEvent([{ kind: 'file', type: 'image/png' }])
    const editor = editorAt(7)

    expect(
      handleRichMarkdownImagePaste({
        editor: editor as never,
        event,
        filePath: '/repo/note.md',
        worktreeId: 'wt-1'
      })
    ).toBe(true)

    expect(event.preventDefault).toHaveBeenCalled()
    await flushPromises()
    expect(window.api.ui.saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      connectionId: 'ssh-1'
    })
    expect(insertRichMarkdownImageFromPath).toHaveBeenCalledWith({
      editor,
      filePath: '/repo/note.md',
      sourcePath: '/tmp/orca-paste-image.png',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: undefined,
      insertPos: 7
    })
  })

  it('does not upload clipboard images to SSH first when the markdown belongs to a runtime', async () => {
    const event = pasteEvent([{ kind: 'file', type: 'image/png' }])

    handleRichMarkdownImagePaste({
      editor: editorAt(3) as never,
      event,
      filePath: '/repo/note.md',
      worktreeId: 'wt-1',
      runtimeEnvironmentId: 'env-1'
    })

    await flushPromises()
    expect(window.api.ui.saveClipboardImageAsTempFile).toHaveBeenCalledWith({
      connectionId: undefined
    })
  })
})
