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

function trackPromiseSettled(promise: Promise<unknown>): () => boolean {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  return () => settled
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

  it('writes bounded clipboard text through the browser clipboard API', async () => {
    const globals = installBrowserGlobals('Linux')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      userAgent: 'Linux',
      hardwareConcurrency: 8,
      clipboard: { writeText }
    })
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ui.writeClipboardText('copy me')).resolves.toBeUndefined()
    await expect(
      globals.window.api.ui.writeTerminalClipboardText('terminal copy')
    ).resolves.toBeUndefined()
    expect(writeText.mock.calls).toEqual([['copy me'], ['terminal copy']])
  })

  it('copies through execCommand when navigator.clipboard is unavailable (insecure context)', async () => {
    const globals = installBrowserGlobals('Linux')
    vi.stubGlobal('navigator', { userAgent: 'Linux', hardwareConcurrency: 8 })
    const clipboard = installExecCommandClipboardDocument()
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ui.writeClipboardText('copy me')).resolves.toBeUndefined()
    expect(clipboard.setData).toHaveBeenCalledWith('text/plain', 'copy me')
    expect(clipboard.execCommand).toHaveBeenCalledWith('copy')
    expect(clipboard.createElement).not.toHaveBeenCalled()
    expect(clipboard.appendChild).not.toHaveBeenCalled()
  })

  it('rejects instead of silently succeeding when no clipboard write path exists', async () => {
    const globals = installBrowserGlobals('Linux')
    vi.stubGlobal('navigator', { userAgent: 'Linux', hardwareConcurrency: 8 })
    vi.stubGlobal('document', {
      activeElement: null,
      createElement: vi.fn(() => ({
        value: '',
        readOnly: false,
        style: {} as Record<string, string>,
        select: vi.fn(),
        remove: vi.fn()
      })),
      execCommand: vi.fn().mockReturnValue(false),
      body: { appendChild: vi.fn() }
    })
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ui.writeClipboardText('copy me')).rejects.toThrow(
      'Clipboard write is unavailable in this browser context'
    )
    await expect(globals.window.api.ui.writeTerminalClipboardText('copy me')).rejects.toThrow(
      'Clipboard write is unavailable in this browser context'
    )
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

  it('yields while reading accepted large browser clipboard text', async () => {
    vi.useFakeTimers()
    const text = 'é'.repeat(300_000)
    const globals = installBrowserGlobals('Linux')
    vi.stubGlobal('navigator', {
      userAgent: 'Linux',
      hardwareConcurrency: 8,
      clipboard: { readText: vi.fn().mockResolvedValue(text) }
    })
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const result = globals.window.api.ui.readClipboardText({ maxBytes: text.length * 3 })
    const isSettled = trackPromiseSettled(result)

    await Promise.resolve()

    expect(isSettled()).toBe(false)
    await vi.runOnlyPendingTimersAsync()
    await expect(result).resolves.toBe(text)
  })

  it('yields before writing accepted large browser clipboard text', async () => {
    vi.useFakeTimers()
    const text = 'é'.repeat(300_000)
    const globals = installBrowserGlobals('Linux')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      userAgent: 'Linux',
      hardwareConcurrency: 8,
      clipboard: { writeText }
    })
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const result = globals.window.api.ui.writeClipboardText(text)
    const isSettled = trackPromiseSettled(result)

    await Promise.resolve()

    expect(isSettled()).toBe(false)
    expect(writeText).not.toHaveBeenCalled()
    await vi.runOnlyPendingTimersAsync()
    await expect(result).resolves.toBeUndefined()
    expect(writeText).toHaveBeenCalledWith(text)
  })

  it('rejects oversized clipboard text writes before calling the browser clipboard API', async () => {
    const globals = installBrowserGlobals('Linux')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', {
      userAgent: 'Linux',
      hardwareConcurrency: 8,
      clipboard: { writeText }
    })
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.ui.writeClipboardText('copied-secret-token-value'.repeat(900_000))
    ).rejects.toThrow('Clipboard text is too large to copy safely.')
    await expect(
      globals.window.api.ui.writeTerminalClipboardText('copied-secret-token-value'.repeat(900_000))
    ).rejects.toThrow('Clipboard text is too large to copy safely.')
    expect(writeText).not.toHaveBeenCalled()
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
    const { CLIPBOARD_IMAGE_UPLOAD_CHUNK_BASE64_CHARS, installWebPreloadApi } =
      await import('./web-preload-api')
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

  it('falls back to one-shot clipboard save for small payloads when the host lacks upload RPCs', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'clipboard.startImageUpload') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: false,
              error: { code: 'method_not_found', message: 'Unknown method' },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: '/tmp/orca-paste-image.png',
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    installClipboardImageBase64(Buffer.from('png-bytes').toString('base64'))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.ui.saveClipboardImageAsTempFile({ connectionId: null })
    ).resolves.toBe('/tmp/orca-paste-image.png')
    expect(runtimeCalls).toEqual([
      {
        method: 'clipboard.startImageUpload',
        params: {
          expectedBase64Length: Buffer.from('png-bytes').toString('base64').length,
          connectionId: null
        }
      },
      {
        method: 'clipboard.saveImageAsTempFile',
        params: {
          contentBase64: Buffer.from('png-bytes').toString('base64'),
          connectionId: null
        }
      }
    ])
  })

  it('does not send large one-shot fallback frames when upload RPCs are missing', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: false,
            error: { code: 'method_not_found', message: 'Unknown method' },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS, installWebPreloadApi } =
      await import('./web-preload-api')
    installClipboardImageBase64('A'.repeat(CLIPBOARD_IMAGE_SINGLE_FRAME_FALLBACK_BASE64_CHARS + 4))
    installWebPreloadApi()

    await expect(globals.window.api.ui.saveClipboardImageAsTempFile()).rejects.toThrow(
      'Unknown method'
    )
    expect(runtimeCalls).toHaveLength(1)
    expect(runtimeCalls[0]?.method).toBe('clipboard.startImageUpload')
  })

  it('aborts best-effort when append fails', async () => {
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
              ok: false,
              error: { code: 'runtime_error', message: 'bad chunk' },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { aborted: true },
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

    await expect(globals.window.api.ui.saveClipboardImageAsTempFile()).rejects.toThrow('bad chunk')
    expect(runtimeCalls.map((call) => call.method)).toEqual([
      'clipboard.startImageUpload',
      'clipboard.appendImageUploadChunk',
      'clipboard.abortImageUpload'
    ])
  })

  it('aborts best-effort when commit fails', async () => {
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
          if (method === 'clipboard.commitImageUpload') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: false,
              error: { code: 'runtime_error', message: 'save failed' },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { aborted: true },
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

    await expect(globals.window.api.ui.saveClipboardImageAsTempFile()).rejects.toThrow(
      'save failed'
    )
    expect(runtimeCalls.map((call) => call.method)).toEqual([
      'clipboard.startImageUpload',
      'clipboard.appendImageUploadChunk',
      'clipboard.commitImageUpload',
      'clipboard.abortImageUpload'
    ])
  })

  it('rejects oversized converted clipboard images before starting an upload', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
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
    installClipboardImageBase64('A'.repeat(24 * 1024 * 1024 + 4))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.ui.saveClipboardImageAsTempFile()).rejects.toThrow(
      'Clipboard image is too large'
    )
    expect(runtimeCalls).toEqual([])
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
    const { MAX_CLIPBOARD_IMAGE_SOURCE_BYTES, installWebPreloadApi } =
      await import('./web-preload-api')
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
    const close = vi.fn()
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
    const { MAX_CLIPBOARD_IMAGE_PIXELS, installWebPreloadApi } = await import('./web-preload-api')
    installClipboardImageBlob(new Blob(['small'], { type: 'image/jpeg' }))
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn().mockResolvedValue({
        close,
        height: 1,
        width: MAX_CLIPBOARD_IMAGE_PIXELS + 1
      })
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
    expect(close).toHaveBeenCalledTimes(1)
    expect(readAsDataURL).not.toHaveBeenCalled()
    expect(runtimeCalls).toEqual([])
  })
})
