// @vitest-environment happy-dom
// Pastes into a structured chat on a paired server land in that server's attachment store, on
// every paste path; the server checks each stored path again when it admits the message.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { NativeChatAttachmentOwner } from './native-chat-attachment-upload'

const mocks = vi.hoisted(() => ({
  saveClipboardImageAsTempFile: vi.fn(),
  readClipboardText: vi.fn(),
  readClipboardImageThumbnail: vi.fn(),
  clipboardHasImage: vi.fn(),
  readClipboardFilePaths: vi.fn(),
  prepareNativeChatSessionAttachmentUpload: vi.fn()
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./native-chat-composer-target', () => ({
  NATIVE_CHAT_CONTEXT_PASTE_MAX_BYTES: 1024
}))

vi.mock('./native-chat-attachment-upload', () => ({
  nativeChatLocalAttachmentUnsupportedNotice: () =>
    'Local attachments are not available for remote sessions.',
  nativeChatWorktreeNotReadyNotice: () => 'Worktree not ready — try again in a moment.',
  prepareNativeChatSessionAttachmentUpload: mocks.prepareNativeChatSessionAttachmentUpload
}))

vi.stubGlobal('window', {
  api: {
    ui: {
      saveClipboardImageAsTempFile: mocks.saveClipboardImageAsTempFile,
      readClipboardText: mocks.readClipboardText,
      readClipboardImageThumbnail: mocks.readClipboardImageThumbnail,
      clipboardHasImage: mocks.clipboardHasImage,
      readClipboardFilePaths: mocks.readClipboardFilePaths
    }
  }
})
vi.stubGlobal('URL', {
  createObjectURL: () => 'blob:clipboard-image',
  revokeObjectURL: () => {}
})

import { useNativeChatComposerPaste } from './use-native-chat-composer-paste'

type HookApi = ReturnType<typeof useNativeChatComposerPaste>
type Chip = { id: string; path: string; pending: boolean }

const sessionOwner: NativeChatAttachmentOwner = {
  kind: 'runtime-session',
  environmentId: 'env-1',
  pairingRevision: 7,
  sessionId: 'session-1'
}
const storeArgs = {
  runtimeEnvironmentId: 'env-1',
  agentSessionAttachment: {
    sessionId: 'session-1',
    expectedEnvironmentPairingRevision: 7,
    expectedEnvironmentRuntimeId: 'runtime-a'
  }
}
const storedPath = '/srv/agent-session-attachments/u1/orca-paste-1.png'

let root: Root | null = null

async function renderPaste(args: {
  attachResolvedPaths?: (...args: unknown[]) => void
  insertTypedText?: (text: string) => boolean
  setNotice?: (notice: string | null) => void
}): Promise<{ api: () => HookApi; chips: Chip[]; begun: () => number; revealed: () => number }> {
  const chips: Chip[] = []
  let counter = 0
  let revealed = 0
  let api: HookApi | null = null
  function Probe(): null {
    api = useNativeChatComposerPaste({
      targetKey: 'session-1',
      agent: 'claude',
      disabled: false,
      caret: 0,
      setCaret: () => {},
      resolveAttachmentOwner: () => sessionOwner,
      attachResolvedPaths: args.attachResolvedPaths ?? (() => {}),
      beginPendingImageAttachment: () => {
        counter += 1
        chips.push({
          id: `chip-${counter}`,
          path: '',
          pending: true
        })
        return `chip-${counter}`
      },
      revealPendingImageAttachment: (id) => {
        const chip = chips.find((candidate) => candidate.id === id)
        if (chip) {
          revealed += 1
        }
      },
      resolvePendingImageAttachment: (id, path) => {
        const chip = chips.find((candidate) => candidate.id === id)
        if (chip) {
          Object.assign(chip, { path, pending: false })
        }
      },
      dropPendingImageAttachment: (id) => {
        chips.splice(
          chips.findIndex((candidate) => candidate.id === id),
          1
        )
      },
      insertTypedText: args.insertTypedText ?? (() => true),
      setNotice: args.setNotice ?? (() => {})
    })
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(createElement(Probe)))
  return {
    api: () => {
      if (!api) {
        throw new Error('Probe did not render')
      }
      return api
    },
    chips,
    begun: () => counter,
    revealed: () => revealed
  }
}

function imagePasteEvent(text = ''): ClipboardEvent {
  const data = new DataTransfer()
  data.items.add(new File(['image'], 'image.png', { type: 'image/png' }))
  if (text) {
    data.setData('text/plain', text)
  }
  return new ClipboardEvent('paste', { clipboardData: data, cancelable: true })
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.readClipboardText.mockResolvedValue('')
  mocks.readClipboardImageThumbnail.mockResolvedValue(null)
  mocks.clipboardHasImage.mockResolvedValue(true)
  mocks.readClipboardFilePaths.mockResolvedValue([])
  mocks.prepareNativeChatSessionAttachmentUpload.mockResolvedValue({
    ok: true,
    target: {
      environmentId: 'env-1',
      sessionId: 'session-1',
      expectedEnvironmentPairingRevision: 7,
      expectedEnvironmentRuntimeId: 'runtime-a'
    }
  })
  mocks.saveClipboardImageAsTempFile.mockResolvedValue(storedPath)
})

afterEach(() => {
  root?.unmount()
  root = null
})

describe('pasting into a structured chat on a paired server', () => {
  it('saves a pasted image into the chat store and settles the chip with its server path', async () => {
    const probe = await renderPaste({})
    await act(async () => probe.api().handlePaste(imagePasteEvent()))
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledExactlyOnceWith(storeArgs)
    expect(probe.chips).toEqual([{ id: 'chip-1', path: storedPath, pending: false }])
  })

  it('keeps the image of a paste that also carries text, its chip shown once the server takes it', async () => {
    const insertTypedText = vi.fn(() => true)
    const probe = await renderPaste({ insertTypedText })
    await act(async () => probe.api().handlePaste(imagePasteEvent('caption')))
    expect(insertTypedText).toHaveBeenCalledWith('caption')
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledExactlyOnceWith(storeArgs)
    expect(probe.chips).toMatchObject([{ path: storedPath, pending: false }])
  })

  it('pastes from the button into the chat store', async () => {
    mocks.readClipboardImageThumbnail.mockResolvedValue({ dataUrl: 'data:image/png;base64,AA' })
    const probe = await renderPaste({})
    await act(async () => probe.api().pasteFromClipboard())
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledExactlyOnceWith(storeArgs)
    expect(probe.chips).toEqual([{ id: 'chip-1', path: storedPath, pending: false }])
  })

  it('settles the server path when no thumbnail was shown', async () => {
    const attachResolvedPaths = vi.fn()
    const probe = await renderPaste({ attachResolvedPaths })
    await act(async () => probe.api().pasteFromClipboard())
    expect(probe.chips).toEqual([{ id: 'chip-1', path: storedPath, pending: false }])
    expect(attachResolvedPaths).not.toHaveBeenCalled()
  })

  it('refuses on a server without the attachment store and saves nothing', async () => {
    mocks.prepareNativeChatSessionAttachmentUpload.mockResolvedValue({
      ok: false,
      notice: 'needs newer server'
    })
    const setNotice = vi.fn()
    const probe = await renderPaste({ setNotice })
    await act(async () => probe.api().handlePaste(imagePasteEvent()))
    expect(mocks.saveClipboardImageAsTempFile).not.toHaveBeenCalled()
    expect(setNotice).toHaveBeenLastCalledWith('needs newer server')
    expect(probe.chips).toHaveLength(0)
  })

  it('keeps the save error apart from the image-paste notice', async () => {
    mocks.saveClipboardImageAsTempFile.mockRejectedValue(
      new Error("Error invoking remote method 'ui:saveClipboardImageAsTempFile': Error: disk full")
    )
    const setNotice = vi.fn()
    const probe = await renderPaste({ setNotice })
    await act(async () => probe.api().handlePaste(imagePasteEvent()))
    expect(setNotice).toHaveBeenLastCalledWith('Image paste failed.', 'disk full')
  })

  it('pastes rich text into a chat on an older server without a refusal beside the text', async () => {
    mocks.prepareNativeChatSessionAttachmentUpload.mockResolvedValue({
      ok: false,
      notice: 'needs newer server'
    })
    const insertTypedText = vi.fn(() => true)
    const setNotice = vi.fn()
    const probe = await renderPaste({ insertTypedText, setNotice })
    await act(async () => probe.api().handlePaste(imagePasteEvent('caption')))
    expect(insertTypedText).toHaveBeenCalledWith('caption')
    expect(setNotice).not.toHaveBeenCalledWith('needs newer server')
    // The operation ends quietly when this server cannot store its image.
    expect(probe.begun()).toBe(1)
    expect(probe.revealed()).toBe(0)
    expect(probe.chips).toEqual([])
  })

  it('pastes rich text from the button into a chat on an older server without a refusal', async () => {
    mocks.prepareNativeChatSessionAttachmentUpload.mockResolvedValue({
      ok: false,
      notice: 'needs newer server'
    })
    mocks.readClipboardText.mockResolvedValue('caption')
    const insertTypedText = vi.fn(() => true)
    const setNotice = vi.fn()
    const probe = await renderPaste({ insertTypedText, setNotice })
    await act(async () => probe.api().pasteFromClipboard())
    expect(insertTypedText).toHaveBeenCalledWith('caption')
    expect(setNotice).not.toHaveBeenCalledWith('needs newer server')
  })

  it('files a paste whose upload lands after a prompt card unmounted the composer', async () => {
    let finishUpload: (path: string) => void = () => {}
    mocks.saveClipboardImageAsTempFile.mockReturnValue(
      new Promise<string>((resolve) => {
        finishUpload = resolve
      })
    )
    const resolved: string[] = []
    const dropped: string[] = []
    let api: HookApi | null = null
    function Probe(): null {
      api = useNativeChatComposerPaste({
        targetKey: 'session-1',
        agent: 'claude',
        disabled: false,
        caret: 0,
        setCaret: () => {},
        resolveAttachmentOwner: () => sessionOwner,
        attachResolvedPaths: () => {},
        beginPendingImageAttachment: () => 'chip-1',
        // The composer's chips file a result that lands after it unmounted into its scope cache.
        resolvePendingImageAttachment: (id, path) => resolved.push(`${id} ${path}`),
        dropPendingImageAttachment: (id) => {
          dropped.push(id)
        },
        insertTypedText: () => true,
        setNotice: () => {}
      })
      return null
    }
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root?.render(createElement(Probe)))
    await act(async () => api?.handlePaste(imagePasteEvent()))
    expect(mocks.saveClipboardImageAsTempFile).toHaveBeenCalledTimes(1)

    act(() => root?.unmount())
    root = null
    await act(async () => finishUpload(storedPath))

    expect(dropped).toEqual([])
    expect(resolved).toEqual([`chip-1 ${storedPath}`])
  })
})
