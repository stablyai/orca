/* eslint-disable max-lines -- Why: web preload parity tests share module-reset
global setup across namespaces so browser API installation stays realistic. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../preload/api-types'
import type { FeatureInteractionState } from '../../../shared/feature-interactions'
import type { RuntimeRpcResponse } from '../../../shared/runtime-rpc-envelope'
import type { TaskSourceContext } from '../../../shared/task-source-context'

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>()

  get length(): number {
    return this.values.size
  }

  clear(): void {
    this.values.clear()
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  key(index: number): string | null {
    return Array.from(this.values.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

function installBrowserGlobals(userAgent = 'Linux'): {
  window: Window & typeof globalThis
  storage: MemoryStorage
} {
  const storage = new MemoryStorage()
  const windowStub = {
    localStorage: storage,
    location: {
      protocol: 'http:',
      reload: vi.fn()
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    atob: (value: string) => Buffer.from(value, 'base64').toString('binary'),
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64')
  } as unknown as Window & typeof globalThis
  vi.stubGlobal('window', windowStub)
  vi.stubGlobal('navigator', { userAgent, hardwareConcurrency: 8 })
  return { window: windowStub, storage }
}

async function installApi(userAgent?: string): Promise<{
  api: PreloadApi
  storage: MemoryStorage
  window: Window & typeof globalThis
}> {
  const globals = installBrowserGlobals(userAgent)
  const { installWebPreloadApi } = await import('./web-preload-api')
  installWebPreloadApi()
  return {
    api: globals.window.api,
    storage: globals.storage,
    window: globals.window
  }
}

function writeStoredRuntimeEnvironment(storage: Storage): void {
  storage.setItem(
    'orca.web.runtimeEnvironment.v1',
    JSON.stringify({
      id: 'web-env-1',
      name: 'Test runtime',
      createdAt: 1,
      updatedAt: 1,
      lastUsedAt: null,
      runtimeId: null,
      preferredEndpointId: 'ws-web-env-1',
      endpoints: [
        {
          id: 'ws-web-env-1',
          kind: 'websocket',
          label: 'WebSocket',
          endpoint: 'ws://127.0.0.1:1234',
          deviceToken: 'token',
          publicKeyB64: 'public-key'
        }
      ]
    })
  )
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

describe('web keybindings preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns snapshots and persists customized bindings in browser storage', async () => {
    const { api, storage } = await installApi('Linux')

    const initial = await api.keybindings.get()
    expect(initial.platform).toBe('linux')
    expect(initial.overrides).toEqual({})

    const updated = await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J']
    })

    expect(updated.overrides['worktree.palette']).toEqual(['Ctrl+Alt+J'])
    expect(storage.getItem('orca.web.keybindings.v1')).toContain('worktree.palette')

    const disabled = await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: []
    })
    expect(disabled.overrides['worktree.palette']).toEqual([])

    const reset = await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: null
    })
    expect(reset.overrides['worktree.palette']).toBeUndefined()
  }, 15_000)

  it('rejects conflicts before mutating browser storage', async () => {
    const { api } = await installApi('Linux')

    await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J']
    })

    await expect(
      api.keybindings.setAction({
        actionId: 'worktree.quickOpen',
        bindings: ['Ctrl+Alt+J']
      })
    ).rejects.toThrow('conflicts')

    const snapshot = await api.keybindings.get()
    expect(snapshot.overrides['worktree.palette']).toEqual(['Ctrl+Alt+J'])
    expect(snapshot.overrides['worktree.quickOpen']).toBeUndefined()
  })

  it('notifies listeners when web keybindings change', async () => {
    const { api } = await installApi('Linux')
    const listener = vi.fn()
    const unsubscribe = api.keybindings.onChanged(listener)

    await api.keybindings.setAction({
      actionId: 'worktree.palette',
      bindings: ['Ctrl+Alt+J']
    })

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({
        overrides: expect.objectContaining({ 'worktree.palette': ['Ctrl+Alt+J'] })
      })
    )

    unsubscribe()
  })
})

describe('web settings preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('migrates first-work branch auto-rename on for stored legacy web settings once', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({ autoRenameBranchFromWork: false })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      autoRenameBranchFromWork?: boolean
      autoRenameBranchFromWorkDefaultedOn?: boolean
    }

    expect(settings.autoRenameBranchFromWork).toBe(true)
    expect(settings.autoRenameBranchFromWorkDefaultedOn).toBe(true)
    expect(stored.autoRenameBranchFromWork).toBe(true)
    expect(stored.autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })

  it('migrates inherited terminal bar cursor defaults for stored web settings once', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem('orca.web.settings.v1', JSON.stringify({ terminalCursorStyle: 'bar' }))
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      terminalCursorStyle?: string
      terminalCursorStyleDefaultedToBlock?: boolean
    }

    expect(settings.terminalCursorStyle).toBe('block')
    expect(settings.terminalCursorStyleDefaultedToBlock).toBe(true)
    expect(stored.terminalCursorStyle).toBe('block')
    expect(stored.terminalCursorStyleDefaultedToBlock).toBe(true)
  })

  it('preserves terminal cursor choices after the web block-default migration', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({
        terminalCursorStyle: 'bar',
        terminalCursorStyleDefaultedToBlock: true
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    expect(settings.terminalCursorStyle).toBe('bar')
    expect(settings.terminalCursorStyleDefaultedToBlock).toBe(true)
  })

  it('preserves first-work branch auto-rename web opt-outs after migration', async () => {
    const globals = installBrowserGlobals('Linux')
    globals.storage.setItem(
      'orca.web.settings.v1',
      JSON.stringify({
        autoRenameBranchFromWork: false,
        autoRenameBranchFromWorkDefaultedOn: true
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const settings = await globals.window.api.settings.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.settings.v1') ?? '{}') as {
      autoRenameBranchFromWork?: boolean
      autoRenameBranchFromWorkDefaultedOn?: boolean
    }

    expect(settings.autoRenameBranchFromWork).toBe(false)
    expect(settings.autoRenameBranchFromWorkDefaultedOn).toBe(true)
    expect(stored.autoRenameBranchFromWork).toBe(false)
    expect(stored.autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })

  it('stamps the first-work branch auto-rename guard for web setting updates', async () => {
    const { api, storage } = await installApi('Linux')

    const settings = await api.settings.set({ autoRenameBranchFromWork: false })
    const stored = JSON.parse(storage.getItem('orca.web.settings.v1') ?? '{}') as {
      autoRenameBranchFromWork?: boolean
      autoRenameBranchFromWorkDefaultedOn?: boolean
    }

    expect(settings.autoRenameBranchFromWork).toBe(false)
    expect(settings.autoRenameBranchFromWorkDefaultedOn).toBe(true)
    expect(stored.autoRenameBranchFromWork).toBe(false)
    expect(stored.autoRenameBranchFromWorkDefaultedOn).toBe(true)
  })
})

describe('web UI preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
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

  it('migrates missing right sidebar visibility from the effective web legacy default', async () => {
    const { api } = await installApi('Linux')

    const ui = await api.ui.get()

    expect(ui.rightSidebarOpen).toBe(false)
  })

  it('keeps explicit local right sidebar visibility over the legacy default', async () => {
    const { api, storage } = await installApi('Linux')
    storage.setItem('orca.web.ui.v1', JSON.stringify({ rightSidebarOpen: true }))

    const ui = await api.ui.get()

    expect(ui.rightSidebarOpen).toBe(true)
  })

  it('keeps newer feature interaction counts when runtime responses resolve out of order', async () => {
    const pending: ((response: RuntimeRpcResponse<unknown>) => void)[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return new Promise((resolve) => {
            pending.push((response) =>
              resolve({
                ...response,
                id: method,
                _meta: { runtimeId: 'runtime-1' }
              })
            )
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const first = globals.window.api.ui.recordFeatureInteraction('tasks')
    const second = globals.window.api.ui.recordFeatureInteraction('tasks')

    pending[1]({
      id: 'second',
      ok: true,
      result: {
        ui: {
          featureInteractions: {
            tasks: { firstInteractedAt: 100, interactionCount: 2 }
          }
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await second
    pending[0]({
      id: 'first',
      ok: true,
      result: {
        ui: {
          featureInteractions: {
            tasks: { firstInteractedAt: 100, interactionCount: 1 }
          }
        }
      },
      _meta: { runtimeId: 'runtime-1' }
    })
    await first

    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      featureInteractions?: FeatureInteractionState
    }
    expect(stored.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 100,
      interactionCount: 2
    })
  })

  it('keeps newer local feature interactions when ui.get returns stale host state', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              ui: {
                featureInteractions: {
                  tasks: { firstInteractedAt: 100, interactionCount: 1 },
                  ports: { firstInteractedAt: 300, interactionCount: 1 }
                }
              }
            },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.ui.v1',
      JSON.stringify({
        featureInteractions: {
          tasks: { firstInteractedAt: 50, interactionCount: 3 }
        }
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      featureInteractions?: FeatureInteractionState
    }

    expect(ui.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 50,
      interactionCount: 3
    })
    expect(stored.featureInteractions?.tasks).toEqual({
      firstInteractedAt: 50,
      interactionCount: 3
    })
    expect(stored.featureInteractions?.ports).toEqual({
      firstInteractedAt: 300,
      interactionCount: 1
    })
  })

  it('union-merges local contextual tour seen ids when ui.get returns stale host state', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              ui: {
                contextualToursSeenIds: ['browser', 'unknown']
              }
            },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.ui.v1',
      JSON.stringify({
        contextualToursSeenIds: ['tasks', 'browser']
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      contextualToursSeenIds?: string[]
    }

    expect(ui.contextualToursSeenIds).toEqual(['tasks', 'browser'])
    expect(stored.contextualToursSeenIds).toEqual(['tasks', 'browser'])
  })

  it('does not keep a local shadow copy of main-owned feature telemetry markers', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: { ui: {} },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.ui.v1',
      JSON.stringify({
        featureInteractionTelemetryBuckets: { tasks: 'count_1000_plus' }
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await globals.window.api.ui.set({
      featureInteractionTelemetryBuckets: { tasks: 'count_500_999' }
    } as never)
    const ui = await globals.window.api.ui.get()
    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as Record<
      string,
      unknown
    >

    expect('featureInteractionTelemetryBuckets' in (ui as Record<string, unknown>)).toBe(false)
    expect(stored.featureInteractionTelemetryBuckets).toBeUndefined()
  })

  it('union-merges local contextual tour seen ids when recordFeatureInteraction returns stale host state', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          return Promise.resolve({
            id: method,
            ok: true,
            result: {
              ui: {
                contextualToursSeenIds: ['browser']
              }
            },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    globals.storage.setItem(
      'orca.web.ui.v1',
      JSON.stringify({
        contextualToursSeenIds: ['tasks']
      })
    )
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const ui = await globals.window.api.ui.recordFeatureInteraction('tasks')
    const stored = JSON.parse(globals.storage.getItem('orca.web.ui.v1') ?? '{}') as {
      contextualToursSeenIds?: string[]
    }

    expect(ui.contextualToursSeenIds).toEqual(['tasks', 'browser'])
    expect(stored.contextualToursSeenIds).toEqual(['tasks', 'browser'])
  })

  it('proxies host skill discovery and computer-use permission APIs for paired web clients', async () => {
    const calls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params: unknown): Promise<RuntimeRpcResponse<unknown>> {
          calls.push({ method, params })
          if (method === 'skills.discover') {
            return Promise.resolve({
              id: method,
              ok: true,
              result: {
                skills: [
                  {
                    id: 'home:computer-use',
                    name: 'computer-use',
                    description: null,
                    providers: ['agent-skills'],
                    sourceKind: 'home',
                    sourceLabel: 'Home',
                    rootPath: '/skills',
                    directoryPath: '/skills/computer-use',
                    skillFilePath: '/skills/computer-use/SKILL.md',
                    installed: true,
                    fileCount: 1,
                    updatedAt: null
                  }
                ],
                sources: [],
                scannedAt: 123
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'computer.permissionsStatus') {
            return Promise.resolve({
              id: method,
              ok: true,
              result: {
                platform: 'darwin',
                helperAppPath: '/Applications/Orca Computer Use.app',
                helperUnavailableReason: null,
                permissions: [
                  { id: 'accessibility', status: 'granted' },
                  { id: 'screenshots', status: 'granted' }
                ]
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'computer.permissions') {
            return Promise.resolve({
              id: method,
              ok: true,
              result: {
                platform: 'darwin',
                helperAppPath: '/Applications/Orca Computer Use.app',
                permissionId:
                  params && typeof params === 'object' ? (params as { id?: string }).id : undefined,
                openedSettings: true,
                launchedHelper: true,
                nextStep: null
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: {},
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.skills.discover()).resolves.toMatchObject({
      skills: [{ name: 'computer-use', installed: true }],
      scannedAt: 123
    })
    const permissionsStatus = await globals.window.api.computerUsePermissions.getStatus()
    expect(permissionsStatus.helperUnavailableReason).toBeNull()
    expect(permissionsStatus.permissions).toContainEqual({ id: 'accessibility', status: 'granted' })
    await expect(
      globals.window.api.computerUsePermissions.openSetup({ id: 'accessibility' })
    ).resolves.toMatchObject({
      openedSettings: true,
      launchedHelper: true,
      permissionId: 'accessibility'
    })
    expect(calls).toEqual(
      expect.arrayContaining([
        { method: 'skills.discover', params: undefined },
        { method: 'computer.permissionsStatus', params: {} },
        { method: 'computer.permissions', params: { id: 'accessibility' } }
      ])
    )
  })

  it('rejects paired web computer-use status failures instead of marking the helper unavailable', async () => {
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string): Promise<RuntimeRpcResponse<unknown>> {
          if (method === 'computer.permissionsStatus') {
            return Promise.reject(new Error('runtime disconnected'))
          }
          return Promise.resolve({
            id: method,
            ok: true,
            result: {},
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(globals.window.api.computerUsePermissions.getStatus()).rejects.toThrow(
      'runtime disconnected'
    )
  })
})

describe('web repos preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it.each([
    ['/home/alice', '/home/alice/orca/projects'],
    ['/', '/orca/projects'],
    ['C:\\', 'C:\\orca\\projects']
  ])(
    'resolves the default create-project parent from runtime host home %s',
    async (resolvedPath, expectedParent) => {
      const runtimeCalls: { method: string; params: unknown }[] = []
      vi.doMock('./web-runtime-client', () => ({
        WebRuntimeClient: class {
          call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
            runtimeCalls.push({ method, params })
            return Promise.resolve({
              id: method,
              ok: true,
              result: { resolvedPath, entries: [] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }

          close(): void {}
        }
      }))

      const globals = installBrowserGlobals('Linux')
      writeStoredRuntimeEnvironment(globals.storage)
      const { installWebPreloadApi } = await import('./web-preload-api')
      installWebPreloadApi()

      await expect(globals.window.api.repos.getDefaultCreateProjectParent()).resolves.toBe(
        expectedParent
      )
      expect(runtimeCalls).toEqual([{ method: 'files.browseServerDir', params: { path: '~' } }])
    }
  )
})

describe('web worktree preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('falls back to legacy worktree.list when detectedList is unavailable', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    const worktree = {
      id: 'repo-1::/workspace/repo',
      repoId: 'repo-1',
      path: '/workspace/repo',
      head: 'abc123',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true,
      displayName: 'repo',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      workspaceStatus: 'todo'
    }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'worktree.detectedList') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: false,
              error: {
                code: 'method_not_found',
                message: 'Unknown method: worktree.detectedList'
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { worktrees: [worktree], totalCount: 1, truncated: false },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const result = await globals.window.api.worktrees.listDetected({ repoId: 'repo-1' })

    expect(result).toMatchObject({
      repoId: 'repo-1',
      authoritative: true,
      source: 'session-fallback',
      worktrees: [{ id: worktree.id, ownership: 'orca-managed', visible: true }]
    })
    expect(runtimeCalls).toEqual([
      { method: 'worktree.detectedList', params: { repo: 'repo-1' } },
      { method: 'worktree.list', params: { repo: 'repo-1', limit: 10_000 } }
    ])
  })
})

describe('web file preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('rejects native save-dialog downloads in paired web clients', async () => {
    const { api } = await installApi('Linux')

    await expect(
      api.fs.downloadFile({ filePath: '/workspace/repo/file.txt', connectionId: 'ssh-1' })
    ).rejects.toThrow('Remote file download is unavailable in paired web clients.')
  })

  it('rejects SSH clone requests in paired web clients', async () => {
    const { api } = await installApi('Linux')

    await expect(
      api.repos.cloneRemote({
        connectionId: 'ssh-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/workspace'
      })
    ).rejects.toThrow('SSH clone is unavailable in paired web clients.')
  })

  it('returns false for runtime missing-path errors from fs.pathExists', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    const worktree = {
      id: 'wt-1',
      repoId: 'repo-1',
      path: '/workspace/repo',
      head: 'abc123',
      branch: 'refs/heads/main',
      isBare: false,
      isMainWorktree: true,
      displayName: 'repo',
      comment: '',
      linkedIssue: null,
      linkedPR: null,
      linkedLinearIssue: null,
      linkedGitLabMR: null,
      linkedGitLabIssue: null,
      isArchived: false,
      isUnread: false,
      isPinned: false,
      sortOrder: 0,
      lastActivityAt: 0,
      workspaceStatus: 'todo'
    }
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'repo.list') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repos: [{ id: 'repo-1' }] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'worktree.detectedList') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { repoId: 'repo-1', authoritative: true, worktrees: [worktree] },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: false,
            error: { code: 'ENOENT', message: 'ENOENT: no such file' },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    await expect(
      globals.window.api.fs.pathExists({ filePath: '/workspace/repo/untitled.md' })
    ).resolves.toBe(false)
    expect(runtimeCalls).toEqual([
      { method: 'repo.list', params: undefined },
      { method: 'worktree.detectedList', params: { repo: 'repo-1' } },
      { method: 'files.stat', params: { worktree: 'id:wt-1', relativePath: 'untitled.md' } }
    ])
  })
})

describe('web GitHub preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
  })

  it('keeps the web GitHub preload key set in parity with the preload contract', async () => {
    const { api } = await installApi('Linux')

    expect(Object.keys(api.gh).sort()).toEqual(
      [
        'addIssueComment',
        'addIssueCommentBySlug',
        'addPRReviewComment',
        'addPRReviewCommentReply',
        'checkOrcaStarred',
        'clearProjectItemField',
        'countWorkItems',
        'createIssue',
        'deleteIssueCommentBySlug',
        'diagnoseAuth',
        'enqueuePRRefresh',
        'getProjectViewTable',
        'issue',
        'listAccessibleProjects',
        'listAssignableUsers',
        'listAssignableUsersBySlug',
        'listIssueTypesBySlug',
        'listIssues',
        'listLabels',
        'listLabelsBySlug',
        'listProjectViews',
        'listWorkItems',
        'mergePR',
        'onPRRefreshEvent',
        'onWorkItemMutated',
        'prCheckDetails',
        'prChecks',
        'prComments',
        'prFileContents',
        'prForBranch',
        'projectWorkItemDetailsBySlug',
        'rateLimit',
        'refreshPRNow',
        'removePRReviewers',
        'repoSlug',
        'repoUpstream',
        'reportVisiblePRRefreshCandidates',
        'rerunPRChecks',
        'requestPRReviewers',
        'resolveProjectRef',
        'resolveReviewThread',
        'setPRAutoMerge',
        'setPRFileViewed',
        'starOrca',
        'updateIssue',
        'updateIssueBySlug',
        'updateIssueCommentBySlug',
        'updateIssueTypeBySlug',
        'updatePRState',
        'updatePRTitle',
        'updateProjectItemField',
        'updatePullRequestBySlug',
        'viewer',
        'workItem',
        'workItemByOwnerRepo',
        'workItemDetails'
      ].sort()
    )
  })

  it('routes every runtime-backed GitHub method through the expected RPC method', async () => {
    type GitHubApi = NonNullable<PreloadApi['gh']>
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { ok: true, items: [], count: 0 },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { GITHUB_WEB_RPC_METHODS, installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = globals.window.api
    const repoPath = '/workspace/repo'
    const withRepo = (params: Record<string, unknown>): Record<string, unknown> => ({
      ...params,
      repo: repoPath
    })

    const routeCases: {
      key: keyof GitHubApi
      args?: unknown
      expectedMethod: string
      expectedParams: unknown
    }[] = [
      {
        key: 'repoSlug',
        args: { repoPath },
        expectedMethod: 'github.repoSlug',
        expectedParams: withRepo({ repoPath })
      },
      {
        key: 'repoUpstream',
        args: { repoPath },
        expectedMethod: 'github.repoUpstream',
        expectedParams: withRepo({ repoPath })
      },
      {
        key: 'prForBranch',
        args: { repoPath, branch: 'feature', linkedPRNumber: 3, fallbackPRNumber: null },
        expectedMethod: 'github.prForBranch',
        expectedParams: withRepo({
          repoPath,
          branch: 'feature',
          linkedPRNumber: 3,
          fallbackPRNumber: null
        })
      },
      {
        key: 'issue',
        args: { repoPath, number: 7 },
        expectedMethod: 'github.issue',
        expectedParams: withRepo({ repoPath, number: 7 })
      },
      {
        key: 'workItem',
        args: { repoPath, number: 7, type: 'issue' },
        expectedMethod: 'github.workItem',
        expectedParams: withRepo({ repoPath, number: 7, type: 'issue' })
      },
      {
        key: 'workItemByOwnerRepo',
        args: { repoPath, owner: 'acme', repo: 'orca', number: 7, type: 'pr' },
        expectedMethod: 'github.workItemByOwnerRepo',
        expectedParams: withRepo({
          repoPath,
          owner: 'acme',
          ownerRepo: 'orca',
          number: 7,
          type: 'pr'
        })
      },
      {
        key: 'workItemDetails',
        args: { repoPath, number: 7, type: 'issue' },
        expectedMethod: 'github.workItemDetails',
        expectedParams: withRepo({ repoPath, number: 7, type: 'issue' })
      },
      {
        key: 'prFileContents',
        args: {
          repoPath,
          prNumber: 7,
          path: 'src/app.ts',
          status: 'modified',
          headSha: 'head',
          baseSha: 'base'
        },
        expectedMethod: 'github.prFileContents',
        expectedParams: withRepo({
          repoPath,
          prNumber: 7,
          path: 'src/app.ts',
          status: 'modified',
          headSha: 'head',
          baseSha: 'base'
        })
      },
      {
        key: 'listIssues',
        args: { repoPath, limit: 10 },
        expectedMethod: 'github.listIssues',
        expectedParams: withRepo({ repoPath, limit: 10 })
      },
      {
        key: 'createIssue',
        args: { repoPath, title: 'Bug', body: 'Details' },
        expectedMethod: 'github.createIssue',
        expectedParams: withRepo({ repoPath, title: 'Bug', body: 'Details' })
      },
      {
        key: 'countWorkItems',
        args: { repoPath, query: 'is:open' },
        expectedMethod: 'github.countWorkItems',
        expectedParams: withRepo({ repoPath, query: 'is:open' })
      },
      {
        key: 'listWorkItems',
        args: { repoPath, limit: 20, query: 'is:pr', before: 'cursor', noCache: true },
        expectedMethod: 'github.listWorkItems',
        expectedParams: withRepo({
          repoPath,
          limit: 20,
          query: 'is:pr',
          before: 'cursor',
          noCache: true
        })
      },
      {
        key: 'prChecks',
        args: { repoPath, prNumber: 7, headSha: 'head', noCache: true },
        expectedMethod: 'github.prChecks',
        expectedParams: withRepo({ repoPath, prNumber: 7, headSha: 'head', noCache: true })
      },
      {
        key: 'prCheckDetails',
        args: { repoPath, checkRunId: 1, checkName: 'test' },
        expectedMethod: 'github.prCheckDetails',
        expectedParams: withRepo({ repoPath, checkRunId: 1, checkName: 'test' })
      },
      {
        key: 'rerunPRChecks',
        args: { repoPath, prNumber: 7, failedOnly: true },
        expectedMethod: 'github.rerunPRChecks',
        expectedParams: withRepo({ repoPath, prNumber: 7, failedOnly: true })
      },
      {
        key: 'prComments',
        args: { repoPath, prNumber: 7, noCache: true },
        expectedMethod: 'github.prComments',
        expectedParams: withRepo({ repoPath, prNumber: 7, noCache: true })
      },
      {
        key: 'resolveReviewThread',
        args: { repoPath, threadId: 'thread-1', resolve: true },
        expectedMethod: 'github.resolveReviewThread',
        expectedParams: withRepo({ repoPath, threadId: 'thread-1', resolve: true })
      },
      {
        key: 'setPRFileViewed',
        args: { repoPath, prNumber: 7, pullRequestId: 'PR_kw', path: 'src/app.ts', viewed: true },
        expectedMethod: 'github.setPRFileViewed',
        expectedParams: withRepo({
          repoPath,
          prNumber: 7,
          pullRequestId: 'PR_kw',
          path: 'src/app.ts',
          viewed: true
        })
      },
      {
        key: 'updatePRTitle',
        args: { repoPath, prNumber: 7, title: 'New title' },
        expectedMethod: 'github.updatePRTitle',
        expectedParams: withRepo({ repoPath, prNumber: 7, title: 'New title' })
      },
      {
        key: 'mergePR',
        args: { repoPath, prNumber: 7, method: 'squash' },
        expectedMethod: 'github.mergePR',
        expectedParams: withRepo({ repoPath, prNumber: 7, method: 'squash' })
      },
      {
        key: 'setPRAutoMerge',
        args: { repoPath, prNumber: 7, enabled: true },
        expectedMethod: 'github.setPRAutoMerge',
        expectedParams: withRepo({ repoPath, prNumber: 7, enabled: true })
      },
      {
        key: 'updatePRState',
        args: { repoPath, prNumber: 7, updates: { state: 'closed' } },
        expectedMethod: 'github.updatePRState',
        expectedParams: withRepo({ repoPath, prNumber: 7, updates: { state: 'closed' } })
      },
      {
        key: 'requestPRReviewers',
        args: { repoPath, prNumber: 7, reviewers: ['alice'] },
        expectedMethod: 'github.requestPRReviewers',
        expectedParams: withRepo({ repoPath, prNumber: 7, reviewers: ['alice'] })
      },
      {
        key: 'removePRReviewers',
        args: { repoPath, prNumber: 7, reviewers: ['alice'] },
        expectedMethod: 'github.removePRReviewers',
        expectedParams: withRepo({ repoPath, prNumber: 7, reviewers: ['alice'] })
      },
      {
        key: 'updateIssue',
        args: { repoPath, number: 7, updates: { state: 'closed' } },
        expectedMethod: 'github.updateIssue',
        expectedParams: withRepo({ repoPath, number: 7, updates: { state: 'closed' } })
      },
      {
        key: 'addIssueComment',
        args: { repoPath, number: 7, body: 'Fixed', type: 'issue' },
        expectedMethod: 'github.addIssueComment',
        expectedParams: withRepo({ repoPath, number: 7, body: 'Fixed', type: 'issue' })
      },
      {
        key: 'addPRReviewCommentReply',
        args: { repoPath, prNumber: 7, commentId: 9, body: 'Reply' },
        expectedMethod: 'github.addPRReviewCommentReply',
        expectedParams: withRepo({ repoPath, prNumber: 7, commentId: 9, body: 'Reply' })
      },
      {
        key: 'addPRReviewComment',
        args: {
          repoPath,
          prNumber: 7,
          commitId: 'head',
          path: 'src/app.ts',
          line: 12,
          body: 'Fix'
        },
        expectedMethod: 'github.addPRReviewComment',
        expectedParams: withRepo({
          repoPath,
          prNumber: 7,
          commitId: 'head',
          path: 'src/app.ts',
          line: 12,
          body: 'Fix'
        })
      },
      {
        key: 'listLabels',
        args: { repoPath },
        expectedMethod: 'github.listLabels',
        expectedParams: withRepo({ repoPath })
      },
      {
        key: 'listAssignableUsers',
        args: { repoPath },
        expectedMethod: 'github.listAssignableUsers',
        expectedParams: withRepo({ repoPath })
      },
      {
        key: 'rateLimit',
        args: { force: true },
        expectedMethod: 'github.rateLimit',
        expectedParams: { force: true }
      },
      {
        key: 'listAccessibleProjects',
        expectedMethod: 'github.project.listAccessible',
        expectedParams: undefined
      },
      {
        key: 'resolveProjectRef',
        args: { input: 'acme/1' },
        expectedMethod: 'github.project.resolveRef',
        expectedParams: { input: 'acme/1' }
      },
      {
        key: 'listProjectViews',
        args: { owner: 'acme', ownerType: 'organization', projectNumber: 1 },
        expectedMethod: 'github.project.listViews',
        expectedParams: { owner: 'acme', ownerType: 'organization', projectNumber: 1 }
      },
      {
        key: 'getProjectViewTable',
        args: { owner: 'acme', ownerType: 'organization', projectNumber: 1 },
        expectedMethod: 'github.project.viewTable',
        expectedParams: { owner: 'acme', ownerType: 'organization', projectNumber: 1 }
      },
      {
        key: 'projectWorkItemDetailsBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, type: 'issue' },
        expectedMethod: 'github.project.workItemDetailsBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, type: 'issue' }
      },
      {
        key: 'updateProjectItemField',
        args: { projectId: 'PVT', itemId: 'PVTI', fieldId: 'field', value: 'done' },
        expectedMethod: 'github.project.updateItemField',
        expectedParams: { projectId: 'PVT', itemId: 'PVTI', fieldId: 'field', value: 'done' }
      },
      {
        key: 'clearProjectItemField',
        args: { projectId: 'PVT', itemId: 'PVTI', fieldId: 'field' },
        expectedMethod: 'github.project.clearItemField',
        expectedParams: { projectId: 'PVT', itemId: 'PVTI', fieldId: 'field' }
      },
      {
        key: 'updateIssueBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, updates: { title: 'New' } },
        expectedMethod: 'github.project.updateIssueBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, updates: { title: 'New' } }
      },
      {
        key: 'updatePullRequestBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, updates: { title: 'New' } },
        expectedMethod: 'github.project.updatePullRequestBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, updates: { title: 'New' } }
      },
      {
        key: 'addIssueCommentBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, body: 'Fixed' },
        expectedMethod: 'github.project.addIssueCommentBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, body: 'Fixed' }
      },
      {
        key: 'updateIssueCommentBySlug',
        args: { owner: 'acme', repo: 'orca', commentId: 9, body: 'Edited' },
        expectedMethod: 'github.project.updateIssueCommentBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', commentId: 9, body: 'Edited' }
      },
      {
        key: 'deleteIssueCommentBySlug',
        args: { owner: 'acme', repo: 'orca', commentId: 9 },
        expectedMethod: 'github.project.deleteIssueCommentBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', commentId: 9 }
      },
      {
        key: 'listLabelsBySlug',
        args: { owner: 'acme', repo: 'orca' },
        expectedMethod: 'github.project.listLabelsBySlug',
        expectedParams: { owner: 'acme', repo: 'orca' }
      },
      {
        key: 'listAssignableUsersBySlug',
        args: { owner: 'acme', repo: 'orca', seedLogins: ['alice'] },
        expectedMethod: 'github.project.listAssignableUsersBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', seedLogins: ['alice'] }
      },
      {
        key: 'listIssueTypesBySlug',
        args: { owner: 'acme', repo: 'orca' },
        expectedMethod: 'github.project.listIssueTypesBySlug',
        expectedParams: { owner: 'acme', repo: 'orca' }
      },
      {
        key: 'updateIssueTypeBySlug',
        args: { owner: 'acme', repo: 'orca', number: 7, issueTypeId: 'it-1' },
        expectedMethod: 'github.project.updateIssueTypeBySlug',
        expectedParams: { owner: 'acme', repo: 'orca', number: 7, issueTypeId: 'it-1' }
      }
    ]

    expect(routeCases.map((routeCase) => routeCase.key).sort()).toEqual(
      Object.keys(GITHUB_WEB_RPC_METHODS).sort()
    )

    for (const routeCase of routeCases) {
      const method = api.gh[routeCase.key] as (args?: unknown) => Promise<unknown>
      await method(routeCase.args)
    }

    await api.gh.refreshPRNow({
      candidate: {
        cacheKey: 'repo-1:feature',
        repoKind: 'git',
        repoId: 'repo-1',
        repoPath,
        branch: 'feature',
        linkedPRNumber: null,
        fallbackPRNumber: 9,
        fallbackPRSource: 'pr-cache'
      }
    })

    expect(runtimeCalls).toEqual([
      ...routeCases.map((routeCase) => ({
        method: routeCase.expectedMethod,
        params: routeCase.expectedParams
      })),
      {
        method: 'github.prForBranch',
        params: {
          repoPath,
          repoId: 'repo-1',
          repo: 'id:repo-1',
          branch: 'feature',
          linkedPRNumber: null,
          fallbackPRNumber: 9
        }
      }
    ])
  })
})

describe('web GitLab preload API', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('./web-runtime-client')
    vi.doUnmock('electron')
  })

  it('keeps the web GitLab preload key set in parity with desktop preload', async () => {
    vi.doMock('electron', () => ({
      ipcRenderer: { invoke: vi.fn() }
    }))
    const globals = installBrowserGlobals('Linux')
    const { glApi } = (await import(
      new URL('../../../preload/gitlab.ts', import.meta.url).href
    )) as {
      glApi: Record<string, unknown>
    }
    const { installWebPreloadApi } = await import('./web-preload-api')

    installWebPreloadApi()

    expect(Object.keys(globals.window.api.gl).sort()).toEqual(Object.keys(glApi).sort())
  })

  it('routes every runtime-backed GitLab method through the expected RPC method', async () => {
    type GitLabApi = NonNullable<PreloadApi['gl']>
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { ok: true, items: [] },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { GITLAB_WEB_RPC_METHODS, installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = globals.window.api
    const repoPath = '/workspace/repo'

    const routeCases: {
      key: keyof typeof GITLAB_WEB_RPC_METHODS
      invoke: (gl: GitLabApi) => Promise<unknown>
      expectedMethod: string
      expectedParams: unknown
    }[] = [
      {
        key: 'diagnoseAuth',
        invoke: (gl) => gl.diagnoseAuth(),
        expectedMethod: 'gitlab.diagnoseAuth',
        expectedParams: undefined
      },
      {
        key: 'rateLimit',
        invoke: (gl) => gl.rateLimit({ force: true, host: 'gitlab.example.com' }),
        expectedMethod: 'gitlab.rateLimit',
        expectedParams: { force: true, host: 'gitlab.example.com' }
      },
      {
        key: 'listMRs',
        invoke: (gl) => gl.listMRs({ repoPath, state: 'opened', page: 1, perPage: 50 }),
        expectedMethod: 'gitlab.listMRs',
        expectedParams: { repoPath, repo: repoPath, state: 'opened', page: 1, perPage: 50 }
      },
      {
        key: 'listWorkItems',
        invoke: (gl) => gl.listWorkItems({ repoPath, state: 'closed', page: 2, perPage: 25 }),
        expectedMethod: 'gitlab.listWorkItems',
        expectedParams: { repoPath, repo: repoPath, state: 'closed', page: 2, perPage: 25 }
      },
      {
        key: 'listIssues',
        invoke: (gl) => gl.listIssues({ repoPath, state: 'all', assignee: '@me', limit: 30 }),
        expectedMethod: 'gitlab.listIssues',
        expectedParams: { repoPath, repo: repoPath, state: 'all', assignee: '@me', limit: 30 }
      },
      {
        key: 'createIssue',
        invoke: (gl) => gl.createIssue({ repoPath, title: 'Bug', body: 'Details' }),
        expectedMethod: 'gitlab.createIssue',
        expectedParams: { repoPath, repo: repoPath, title: 'Bug', body: 'Details' }
      },
      {
        key: 'updateIssue',
        invoke: (gl) => gl.updateIssue({ repoPath, number: 7, updates: { state: 'closed' } }),
        expectedMethod: 'gitlab.updateIssue',
        expectedParams: { repoPath, repo: repoPath, number: 7, updates: { state: 'closed' } }
      },
      {
        key: 'addIssueComment',
        invoke: (gl) => gl.addIssueComment({ repoPath, number: 7, body: 'Fixed' }),
        expectedMethod: 'gitlab.addIssueComment',
        expectedParams: { repoPath, repo: repoPath, number: 7, body: 'Fixed' }
      },
      {
        key: 'listLabels',
        invoke: (gl) => gl.listLabels({ repoPath }),
        expectedMethod: 'gitlab.listLabels',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'todos',
        invoke: (gl) => gl.todos({ repoPath }),
        expectedMethod: 'gitlab.todos',
        expectedParams: { repoPath, repo: repoPath }
      },
      {
        key: 'workItemDetails',
        invoke: (gl) => gl.workItemDetails({ repoPath, iid: 8, type: 'mr' }),
        expectedMethod: 'gitlab.workItemDetails',
        expectedParams: { repoPath, repo: repoPath, iid: 8, type: 'mr' }
      },
      {
        key: 'closeMR',
        invoke: (gl) => gl.closeMR({ repoPath, iid: 8 }),
        expectedMethod: 'gitlab.updateMRState',
        expectedParams: { repoPath, repo: repoPath, iid: 8, state: 'closed' }
      },
      {
        key: 'reopenMR',
        invoke: (gl) => gl.reopenMR({ repoPath, iid: 8 }),
        expectedMethod: 'gitlab.updateMRState',
        expectedParams: { repoPath, repo: repoPath, iid: 8, state: 'opened' }
      },
      {
        key: 'mergeMR',
        invoke: (gl) => gl.mergeMR({ repoPath, iid: 8, method: 'squash' }),
        expectedMethod: 'gitlab.mergeMR',
        expectedParams: { repoPath, repo: repoPath, iid: 8, method: 'squash' }
      },
      {
        key: 'updateMR',
        invoke: (gl) => gl.updateMR({ repoPath, iid: 8, updates: { title: 'New title' } }),
        expectedMethod: 'gitlab.updateMR',
        expectedParams: { repoPath, repo: repoPath, iid: 8, updates: { title: 'New title' } }
      },
      {
        key: 'updateMRReviewers',
        invoke: (gl) => gl.updateMRReviewers({ repoPath, iid: 8, reviewerIds: [1, 2] }),
        expectedMethod: 'gitlab.updateMRReviewers',
        expectedParams: { repoPath, repo: repoPath, iid: 8, reviewerIds: [1, 2] }
      },
      {
        key: 'addMRComment',
        invoke: (gl) => gl.addMRComment({ repoPath, iid: 8, body: 'Ship it' }),
        expectedMethod: 'gitlab.addMRComment',
        expectedParams: { repoPath, repo: repoPath, iid: 8, body: 'Ship it' }
      },
      {
        key: 'addMRInlineComment',
        invoke: (gl) =>
          gl.addMRInlineComment({
            repoPath,
            iid: 8,
            input: {
              body: 'Please fix',
              path: 'src/app.ts',
              line: 12,
              baseSha: 'base',
              startSha: 'start',
              headSha: 'head'
            }
          }),
        expectedMethod: 'gitlab.addMRInlineComment',
        expectedParams: {
          repoPath,
          repo: repoPath,
          iid: 8,
          input: {
            body: 'Please fix',
            path: 'src/app.ts',
            line: 12,
            baseSha: 'base',
            startSha: 'start',
            headSha: 'head'
          }
        }
      },
      {
        key: 'resolveMRDiscussion',
        invoke: (gl) =>
          gl.resolveMRDiscussion({
            repoPath,
            iid: 8,
            discussionId: 'discussion-1',
            resolved: true
          }),
        expectedMethod: 'gitlab.resolveMRDiscussion',
        expectedParams: {
          repoPath,
          repo: repoPath,
          iid: 8,
          discussionId: 'discussion-1',
          resolved: true
        }
      },
      {
        key: 'jobTrace',
        invoke: (gl) => gl.jobTrace({ repoPath, jobId: 99 }),
        expectedMethod: 'gitlab.jobTrace',
        expectedParams: { repoPath, repo: repoPath, jobId: 99 }
      },
      {
        key: 'retryJob',
        invoke: (gl) => gl.retryJob({ repoPath, jobId: 99 }),
        expectedMethod: 'gitlab.retryJob',
        expectedParams: { repoPath, repo: repoPath, jobId: 99 }
      },
      {
        key: 'workItemByPath',
        invoke: (gl) =>
          gl.workItemByPath({
            repoPath,
            host: 'gitlab.example.com',
            path: 'group/project',
            iid: 7,
            type: 'issue'
          }),
        expectedMethod: 'gitlab.workItemByPath',
        expectedParams: {
          repoPath,
          repo: repoPath,
          host: 'gitlab.example.com',
          path: 'group/project',
          iid: 7,
          type: 'issue'
        }
      }
    ]

    expect(routeCases.map((routeCase) => routeCase.key).sort()).toEqual(
      Object.keys(GITLAB_WEB_RPC_METHODS).sort()
    )

    for (const routeCase of routeCases) {
      await routeCase.invoke(api.gl)
    }

    expect(runtimeCalls).toEqual(
      routeCases.map((routeCase) => ({
        method: routeCase.expectedMethod,
        params: routeCase.expectedParams
      }))
    )
  })

  it('routes GitLab repo selectors through repo id when provided', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: method === 'gitlab.workItemDetails' ? null : { ok: true, items: [] },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = globals.window.api
    const sourceContext: TaskSourceContext = {
      kind: 'task-source',
      provider: 'gitlab',
      projectId: 'gitlab:gitlab.example.com/group/project',
      hostId: 'runtime:web-env-1',
      repoId: 'repo-gitlab-runtime',
      providerIdentity: {
        provider: 'gitlab',
        projectId: '42',
        namespace: 'group',
        project: 'project',
        webUrl: 'https://gitlab.example.com/group/project'
      }
    }

    await api.gl.listIssues({
      repoPath: '/workspace/repo',
      repoId: 'repo-gitlab-runtime',
      sourceContext,
      state: 'opened'
    })
    await api.gl.updateMR({
      repoPath: '/workspace/repo',
      repoId: 'repo-gitlab-runtime',
      sourceContext,
      iid: 9,
      updates: { title: 'New title' }
    })
    await api.gl.workItemDetails({
      repoPath: '/workspace/repo',
      repoId: 'repo-gitlab-runtime',
      sourceContext,
      iid: 9,
      type: 'mr'
    })

    expect(runtimeCalls).toEqual([
      {
        method: 'gitlab.listIssues',
        params: {
          repoPath: '/workspace/repo',
          repoId: 'repo-gitlab-runtime',
          sourceContext,
          repo: 'id:repo-gitlab-runtime',
          state: 'opened'
        }
      },
      {
        method: 'gitlab.updateMR',
        params: {
          repoPath: '/workspace/repo',
          repoId: 'repo-gitlab-runtime',
          sourceContext,
          repo: 'id:repo-gitlab-runtime',
          iid: 9,
          updates: { title: 'New title' }
        }
      },
      {
        method: 'gitlab.workItemDetails',
        params: {
          repoPath: '/workspace/repo',
          repoId: 'repo-gitlab-runtime',
          sourceContext,
          repo: 'id:repo-gitlab-runtime',
          iid: 9,
          type: 'mr'
        }
      }
    ])
  })

  it('exposes the GitLab task methods used by the shared Tasks page', async () => {
    const runtimeCalls: { method: string; params: unknown }[] = []
    vi.doMock('./web-runtime-client', () => ({
      WebRuntimeClient: class {
        call(method: string, params?: unknown): Promise<RuntimeRpcResponse<unknown>> {
          runtimeCalls.push({ method, params })
          if (method === 'gitlab.listMRs') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: {
                items: [{ id: 'mr-1', type: 'mr', number: 1 }]
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'gitlab.listIssues') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: {
                items: [{ id: 'issue-2', type: 'issue', number: 2 }]
              },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          if (method === 'gitlab.workItemByPath') {
            return Promise.resolve({
              id: `call-${runtimeCalls.length}`,
              ok: true,
              result: { id: 'issue-7', type: 'issue', number: 7 },
              _meta: { runtimeId: 'runtime-1' }
            })
          }
          return Promise.resolve({
            id: `call-${runtimeCalls.length}`,
            ok: true,
            result: { ok: true },
            _meta: { runtimeId: 'runtime-1' }
          })
        }

        close(): void {}
      }
    }))

    const globals = installBrowserGlobals('Linux')
    writeStoredRuntimeEnvironment(globals.storage)
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = globals.window.api

    const mergeRequests = await api.gl.listMRs({
      repoPath: '/workspace/repo',
      state: 'opened',
      page: 1,
      perPage: 50
    })
    const issues = await api.gl.listIssues({
      repoPath: '/workspace/repo',
      state: 'opened',
      assignee: '@me',
      limit: 50
    })
    const item = await api.gl.workItemByPath({
      repoPath: '/workspace/repo',
      host: 'gitlab.example.com',
      path: 'group/project',
      iid: 7,
      type: 'issue'
    })
    await api.gl.closeMR({ repoPath: '/workspace/repo', iid: 7 })

    expect(mergeRequests.items).toEqual([{ id: 'mr-1', type: 'mr', number: 1 }])
    expect(issues.items).toEqual([{ id: 'issue-2', type: 'issue', number: 2 }])
    expect(item).toEqual({ id: 'issue-7', type: 'issue', number: 7 })
    expect(runtimeCalls.map((call) => call.method)).not.toContain('gitlab.listWorkItems')
    expect(runtimeCalls).toEqual([
      {
        method: 'gitlab.listMRs',
        params: {
          repoPath: '/workspace/repo',
          repo: '/workspace/repo',
          state: 'opened',
          page: 1,
          perPage: 50
        }
      },
      {
        method: 'gitlab.listIssues',
        params: {
          repoPath: '/workspace/repo',
          repo: '/workspace/repo',
          state: 'opened',
          assignee: '@me',
          limit: 50
        }
      },
      {
        method: 'gitlab.workItemByPath',
        params: {
          repoPath: '/workspace/repo',
          repo: '/workspace/repo',
          host: 'gitlab.example.com',
          path: 'group/project',
          iid: 7,
          type: 'issue'
        }
      },
      {
        method: 'gitlab.updateMRState',
        params: {
          repoPath: '/workspace/repo',
          repo: '/workspace/repo',
          iid: 7,
          state: 'closed'
        }
      }
    ])
  })
})
