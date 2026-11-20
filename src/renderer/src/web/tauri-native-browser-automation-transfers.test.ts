// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeRpcResponse } from '../../../shared/remote-runtime/rpc/runtime-rpc-envelope'
import type { AutomationCommandContext, TauriCdpSender } from './tauri-native-browser-automation'
import {
  downloadTauriBrowserFile,
  uploadTauriBrowserFiles
} from './tauri-native-browser-automation-transfers'
import type { TauriBrowserHostClient } from './tauri-native-browser-client-host'
import type { TauriFileChannelAuthority } from './tauri-native-browser-file-channel'
import { resetTauriBrowserFileChannelForTest } from './tauri-native-browser-file-channel'

const native = vi.hoisted(() => ({
  invoke: vi.fn(),
  listeners: new Map<string, (payload: unknown) => void>()
}))
vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  listenNative: (event: string, handler: (payload: unknown) => void) => {
    native.listeners.set(event, handler)
    return () => {}
  }
}))

function okResult(result: unknown): RuntimeRpcResponse<unknown> {
  return { id: 'test', ok: true, result, _meta: { runtimeId: 'runtime-1' } }
}

function createRoute(browserPageId: string): TauriFileChannelAuthority {
  return {
    authority: {
      authorityRuntimeId: 'runtime-1',
      authorityEpoch: 'epoch-1',
      browserHostClientId: 'host-1',
      browserHostGeneration: 3
    },
    browserPageId,
    pageHostGeneration: 1
  }
}

function createClient(
  readChunks: unknown[],
  writeResult: unknown
): {
  client: TauriBrowserHostClient
  calls: { method: string; params: unknown }[]
} {
  const calls: { method: string; params: unknown }[] = []
  let reads = 0
  const client: TauriBrowserHostClient = {
    subscribe: vi.fn(async () => ({ unsubscribe: vi.fn() })),
    call: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params })
      if (method === 'browser.clientHost.fileChannel.read') {
        const chunk = readChunks.at(Math.min(reads, readChunks.length - 1))
        reads += 1
        return okResult(chunk)
      }
      return okResult(writeResult)
    })
  }
  return { client, calls }
}

function createContext(send: TauriCdpSender, pageId = 'upload-1'): AutomationCommandContext {
  return {
    browserPageId: pageId,
    send,
    refs: new Map([['@e1', { backendDOMNodeId: 7, role: 'textbox', name: 'file' }]])
  }
}

function emitDownloadFinished(payload: unknown): void {
  native.listeners.get('browser:download-finished')?.(payload)
}

async function flushToMacrotask(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 0)
  })
}

beforeEach(() => {
  native.invoke.mockReset()
  // The download listener installs once per module (like production); pending
  // downloads reset per test while the listener stays installed.
  resetTauriBrowserFileChannelForTest()
})

describe('Tauri browser upload transfers', () => {
  it('rejects file lists the channel cannot carry', async () => {
    const { client } = createClient([], { accepted: true })
    const send: TauriCdpSender = async () => ({})
    const route = createRoute('upload-1')
    await expect(
      uploadTauriBrowserFiles(client, route, createContext(send), '@e1', [])
    ).rejects.toThrow('browser_invalid_params')
    await expect(
      uploadTauriBrowserFiles(client, route, createContext(send), '@e1', [42])
    ).rejects.toThrow('browser_invalid_params')
    await expect(
      uploadTauriBrowserFiles(client, route, createContext(send), '@missing', ['a.txt'])
    ).rejects.toThrow('browser_ref_not_found')
  })

  it('pulls the remote file through the channel and stages it for CDP', async () => {
    const { client } = createClient(
      [{ contentBase64: 'aGVsbG8=', bytesRead: 5, totalBytes: 5, eof: true }],
      { accepted: true }
    )
    const sent: { method: string; params: Record<string, unknown> }[] = []
    const send: TauriCdpSender = async (method, params = {}) => {
      sent.push({ method, params })
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'oid-9' } }
      }
      return {}
    }
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'poc_browser_stage_upload_chunk') {
        return { uploadId: 'u-1', stagingPath: '/tmp/stage/notes.txt' }
      }
      return undefined
    })
    const route = createRoute('upload-1')
    const outcome = await uploadTauriBrowserFiles(client, route, createContext(send), '@e1', [
      'docs/notes.txt'
    ])
    expect(outcome).toEqual({ uploaded: 1 })
    expect(sent).toContainEqual({
      method: 'DOM.setFileInputFiles',
      params: { objectId: 'oid-9', files: ['/tmp/stage/notes.txt'] }
    })
    expect(native.invoke).toHaveBeenCalledWith('poc_browser_discard_staged_upload', {
      uploadId: 'u-1'
    })
  })

  it('discards staged bytes when a later chunk fails', async () => {
    const { client } = createClient(
      [
        { contentBase64: 'aGVsbG8=', bytesRead: 5, totalBytes: 10, eof: false },
        { contentBase64: 'aGVsbG8=', bytesRead: 5, totalBytes: 10, eof: true }
      ],
      { accepted: true }
    )
    const send: TauriCdpSender = async (method) => {
      if (method === 'DOM.resolveNode') {
        return { object: { objectId: 'oid-9' } }
      }
      return {}
    }
    let stages = 0
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'poc_browser_stage_upload_chunk') {
        stages += 1
        if (stages > 1) {
          throw new Error('nope')
        }
        return { uploadId: 'u-9', stagingPath: null }
      }
      return undefined
    })
    const route = createRoute('upload-1')
    await expect(
      uploadTauriBrowserFiles(client, route, createContext(send), '@e1', ['docs/big.txt'])
    ).rejects.toThrow()
    expect(native.invoke).toHaveBeenCalledWith('poc_browser_discard_staged_upload', {
      uploadId: 'u-9'
    })
  })
})

describe('Tauri browser download transfers', () => {
  it('rejects selectors and paths the transfer cannot use', async () => {
    const { client } = createClient([], { accepted: true })
    const send: TauriCdpSender = async () => ({})
    const route = createRoute('dl-bad')
    await expect(downloadTauriBrowserFile(client, route, send, '', 'dl/a.bin')).rejects.toThrow(
      'browser_invalid_params'
    )
    await expect(downloadTauriBrowserFile(client, route, send, 'a', 42)).rejects.toThrow(
      'browser_invalid_params'
    )
  })

  it('clicks the target, relays the download, and commits it remotely', async () => {
    const { client, calls } = createClient([], {
      accepted: true,
      workspaceRelativePath: 'downloads/a.bin'
    })
    const send: TauriCdpSender = async (method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 5, y: 6 } } }
      }
      return {}
    }
    native.invoke.mockImplementation(async (command: string) => {
      if (command === 'poc_browser_relay_download_chunk') {
        return { contentBase64: 'aGVsbG8=', bytesRead: 5, eof: true }
      }
      return undefined
    })
    const route = createRoute('dl-ok')
    const pending = downloadTauriBrowserFile(client, route, send, 'a[download]', 'a.bin')
    // Listener install and pending-download registration complete in
    // microtasks; flush to a macrotask so the emit below cannot run ahead.
    await flushToMacrotask()
    expect(native.listeners.has('browser:download-finished')).toBe(true)
    emitDownloadFinished({
      browserPageId: 'dl-ok',
      downloadId: 'd-1',
      status: 'completed',
      savePath: '/tmp/tauri-dl/a.bin'
    })
    const outcome = await pending
    expect(outcome).toEqual({ downloaded: true, path: 'downloads/a.bin' })
    expect(calls.some((call) => call.method === 'browser.clientHost.fileChannel.write')).toBe(true)
    expect(native.invoke).toHaveBeenCalledWith('poc_browser_cleanup_relayed_download', {
      savePath: '/tmp/tauri-dl/a.bin'
    })
  })

  it('fails the transfer when the native download fails', async () => {
    const { client } = createClient([], { accepted: true })
    const send: TauriCdpSender = async (method) => {
      if (method === 'Runtime.evaluate') {
        return { result: { value: { x: 5, y: 6 } } }
      }
      return {}
    }
    const route = createRoute('dl-fail')
    const pending = downloadTauriBrowserFile(client, route, send, 'a[download]', 'a.bin')
    await flushToMacrotask()
    expect(native.listeners.has('browser:download-finished')).toBe(true)
    emitDownloadFinished({ browserPageId: 'dl-fail', status: 'failed', savePath: null })
    await expect(pending).rejects.toThrow('browser_client_download_failed')
  })
})
