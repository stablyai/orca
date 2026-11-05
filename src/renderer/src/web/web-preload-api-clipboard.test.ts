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

function installClipboardImageBase64(contentBase64: string): void {
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
          getType: vi.fn().mockResolvedValue(new Blob(['ignored'], { type: 'image/png' }))
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

  it('saves browser clipboard images through bounded upload chunks', async () => {
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
      globals.window.api.ui.saveClipboardImageAsTempFile({ connectionId: 'ssh-1' })
    ).resolves.toBe('C:\\Users\\alice\\AppData\\Local\\Temp\\orca-paste-image.png')
    expect(runtimeCalls).toEqual([
      {
        method: 'clipboard.startImageUpload',
        params: {
          expectedBase64Length: contentBase64.length,
          connectionId: 'ssh-1'
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
  })

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

  it('rejects oversized decoded clipboard images before canvas conversion', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    const revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    const readAsDataURL = vi.fn(() => {
      throw new Error('FileReader should not receive oversized decoded image data')
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
    const { MAX_CLIPBOARD_IMAGE_PIXELS } = await import('./preload-api/web-clipboard-api')
    installClipboardImageBlob(new Blob(['small'], { type: 'image/jpeg' }))
    vi.stubGlobal(
      'Image',
      class {
        src = ''
        naturalHeight = 1
        naturalWidth = MAX_CLIPBOARD_IMAGE_PIXELS + 1
        decode = vi.fn().mockResolvedValue(undefined)
      }
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
    expect(revokeObjectURL).toHaveBeenCalledTimes(1)
    revokeObjectURL.mockRestore()
    expect(readAsDataURL).not.toHaveBeenCalled()
    expect(runtimeCalls).toEqual([])
  })
})
