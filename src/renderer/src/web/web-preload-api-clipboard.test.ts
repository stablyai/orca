import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import {
  installBrowserGlobals,
  writeStoredRuntimeEnvironment
} from './web-preload-api-test-harness'

function installExecCommandClipboardDocument(execCommandResult = true): {
  appendChild: ReturnType<typeof vi.fn>
  createElement: ReturnType<typeof vi.fn>
  execCommand: ReturnType<typeof vi.fn>
  setData: ReturnType<typeof vi.fn>
} {
  const listeners: ((event: unknown) => void)[] = []
  const setData = vi.fn()
  const createElement = vi.fn()
  const appendChild = vi.fn()
  const execCommand = vi.fn((command: string) => {
    if (command === 'copy') {
      for (const listener of listeners.slice()) {
        listener({
          clipboardData: { setData },
          preventDefault: vi.fn(),
          stopImmediatePropagation: vi.fn()
        })
      }
    }
    return execCommandResult
  })
  vi.stubGlobal('document', {
    execCommand,
    addEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      if (type === 'copy') {
        listeners.push(listener)
      }
    }),
    removeEventListener: vi.fn((type: string, listener: (event: unknown) => void) => {
      if (type === 'copy') {
        listeners.splice(listeners.indexOf(listener), 1)
      }
    }),
    createElement,
    body: { appendChild }
  })
  return { appendChild, createElement, execCommand, setData }
}

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function stubDecodedImageSize(width: number, height: number): void {
  vi.stubGlobal(
    'Image',
    class {
      src = ''
      naturalWidth = width
      naturalHeight = height
      decode = vi.fn().mockResolvedValue(undefined)
    }
  )
}

function installClipboardImageBase64(contentBase64: string): void {
  stubDecodedImageSize(800, 600)
  vi.stubGlobal(
    'FileReader',
    class {
      result: string | ArrayBuffer | null = null
      error: DOMException | null = null
      onload: (() => void) | null = null
      onerror: (() => void) | null = null

      readAsDataURL(blob: Blob): void {
        this.result = `data:${blob.type};base64,${contentBase64}`
        this.onload?.()
      }
    }
  )
  vi.stubGlobal('navigator', {
    userAgent: 'Linux',
    hardwareConcurrency: 8,
    clipboard: {
      readText: vi.fn().mockResolvedValue(''),
      read: vi.fn().mockResolvedValue([
        {
          types: ['image/png'],
          getType: vi.fn().mockResolvedValue(new Blob([PNG_BYTES], { type: 'image/png' }))
        }
      ])
    }
  })
}

function installClipboardImageBlob(blob: Blob): {
  getType: ReturnType<typeof vi.fn>
  read: ReturnType<typeof vi.fn>
} {
  const getType = vi.fn().mockResolvedValue(blob)
  const read = vi.fn().mockResolvedValue([
    {
      types: [blob.type || 'image/png'],
      getType
    }
  ])
  vi.stubGlobal('navigator', {
    userAgent: 'Linux',
    hardwareConcurrency: 8,
    clipboard: {
      readText: vi.fn().mockResolvedValue(''),
      read
    }
  })
  return { getType, read }
}

describe('web UI preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('falls back to execCommand when the browser clipboard write is permission-gated', async () => {
    const globals = installBrowserGlobals('Linux')
    const writeText = vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    vi.stubGlobal('navigator', {
      userAgent: 'Linux',
      hardwareConcurrency: 8,
      clipboard: { writeText }
    })
    const clipboard = installExecCommandClipboardDocument()
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ui.writeClipboardText('copy me')).resolves.toBeUndefined()
    expect(writeText).toHaveBeenCalledWith('copy me')
    expect(clipboard.setData).toHaveBeenCalledWith('text/plain', 'copy me')
    expect(clipboard.createElement).not.toHaveBeenCalled()
    expect(clipboard.appendChild).not.toHaveBeenCalled()
  })

  it('downscales a pasted browser PNG above the pixel cap', async () => {
    installClipboardImageBlob(new Blob([PNG_BYTES], { type: 'image/png' }))
    stubDecodedImageSize(8000, 6000)
    const fitted = new Blob([PNG_BYTES], { type: 'image/png' })
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: vi.fn() }),
      toBlob: (callback: (blob: Blob) => void) => callback(fitted)
    }
    vi.stubGlobal('document', { createElement: () => canvas })
    const readAsDataURL = vi.fn(function (this: { result: string; onload: () => void }) {
      this.result = 'data:image/png;base64,Zml0dGVk'
      this.onload()
    })
    vi.stubGlobal(
      'FileReader',
      class {
        readAsDataURL = readAsDataURL
      }
    )
    const { readClipboardImagePngBase64 } = await import('./preload-api/web-clipboard-api')

    await expect(readClipboardImagePngBase64()).resolves.toBe('Zml0dGVk')
    expect({ width: canvas.width, height: canvas.height }).toEqual({ width: 6688, height: 5016 })
    expect(readAsDataURL).toHaveBeenCalledWith(fitted)
  })

  it.each([
    { flag: undefined, destination: {} },
    { flag: true, destination: { forNativeChatDraft: true } }
  ])(
    'saves browser clipboard images through bounded upload chunks ($flag)',
    async ({ flag, destination }) => {
      const runtimeCalls: { method: string; params: unknown }[] = []
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
            runtimeCalls.push({ method, params })
            if (method === 'clipboard.startImageUpload') {
              return Promise.resolve({
                id: `call-${runtimeCalls.length}`,
                ok: true,
                result: { uploadId: 'upload-1' },
                _meta: { runtimeId: 'runtime-1' }
              })
            }
            if (method === 'clipboard.appendImageUploadChunk') {
              return Promise.resolve({
                id: `call-${runtimeCalls.length}`,
                ok: true,
                result: { receivedBase64Length: runtimeCalls.length },
                _meta: { runtimeId: 'runtime-1' }
              })
            }
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: 'C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-image.png',
              _meta: { runtimeId: 'runtime-1' }
            })
          }

          close(): void {}
        }
      }))

      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage)
      const { installWebPreloadApi } = await import('./web-preload-api')
      const { CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS } =
        await import('./preload-api/web-clipboard-api')
      const contentBase64 = `${'A'.repeat(CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS)}AAAA`
      installClipboardImageBase64(contentBase64)
      installWebPreloadApi()

      await expect(
        globals.window.api.ui.saveClipboardImageAsTempFile({
          connectionId: 'ssh-1',
          forNativeChatDraft: flag
        })
      ).resolves.toBe('C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-image.png')
      expect(runtimeCalls).toEqual([
        {
          method: 'clipboard.startImageUpload',
          params: {
            expectedBase64Length: contentBase64.length,
            connectionId: 'ssh-1',
            ...destination
          }
        },
        {
          method: 'clipboard.appendImageUploadChunk',
          params: {
            uploadId: 'upload-1',
            offset: 0,
            contentBase64: 'A'.repeat(CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS)
          }
        },
        {
          method: 'clipboard.appendImageUploadChunk',
          params: {
            uploadId: 'upload-1',
            offset: CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS,
            contentBase64: 'AAAA'
          }
        },
        {
          method: 'clipboard.commitImageUpload',
          params: { uploadId: 'upload-1' }
        }
      ])
    }
  )

  it.each([
    { flag: undefined, destination: {} },
    { flag: true, destination: { forNativeChatDraft: true } }
  ])(
    'preserves the image destination on the old-server fallback ($flag)',
    async ({ flag, destination }) => {
      const runtimeCalls: { method: string; params: unknown }[] = []
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
            runtimeCalls.push({ method, params })
            if (method === 'clipboard.startImageUpload') {
              return Promise.resolve({
                id: 'start',
                ok: false,
                error: { code: 'method_not_found', message: 'Unknown method' },
                _meta: { runtimeId: 'runtime-1' }
              })
            }
            return Promise.resolve({
              id: 'save',
              ok: true,
              result: '/runtime/paste.png',
              _meta: { runtimeId: 'runtime-1' }
            })
          }

          close(): void {}
        }
      }))
      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage)
      installClipboardImageBase64('AAAA')
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()

      await expect(
        globals.window.api.ui.saveClipboardImageAsTempFile({ forNativeChatDraft: flag })
      ).resolves.toBe('/runtime/paste.png')
      expect(runtimeCalls).toEqual([
        {
          method: 'clipboard.startImageUpload',
          params: { expectedBase64Length: 4, connectionId: null, ...destination }
        },
        {
          method: 'clipboard.saveImageAsTempFile',
          params: { contentBase64: 'AAAA', connectionId: null, ...destination }
        }
      ])
    }
  )

  it('rejects oversized clipboard image source blobs before FileReader or upload work', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    const readAsDataURL = vi.fn(() => {
      throw new Error('FileReader should not receive oversized clipboard image data')
    })
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: null,
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    const { MAX_CLIPBOARD_IMAGE_SOURCE_BYTES } = await import('./preload-api/web-clipboard-api')
    const clipboard = installClipboardImageBlob(
      new Blob([new Uint8Array(MAX_CLIPBOARD_IMAGE_SOURCE_BYTES + 1)], { type: 'image/png' })
    )
    vi.stubGlobal(
      'FileReader',
      class {
        readAsDataURL = readAsDataURL
      }
    )
    installWebPreloadApi()

    await expect(globals.window.api.ui.saveClipboardImageAsTempFile()).rejects.toThrow(
      'Clipboard image is too large'
    )
    expect(clipboard.read).toHaveBeenCalledTimes(1)
    expect(clipboard.getType).toHaveBeenCalledTimes(1)
    expect(readAsDataURL).not.toHaveBeenCalled()
    expect(runtimeCalls).toEqual([])
  })
})
