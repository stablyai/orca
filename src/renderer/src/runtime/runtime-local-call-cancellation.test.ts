// oxlint-disable-next-line typescript/triple-slash-reference -- Host build constants are ambient declarations with no runtime module.
/// <reference path="../../../types/build-constants.d.ts" />

import type * as FsPromisesModule from 'node:fs/promises'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const { handlers, listeners, rendererListeners, pendingOpen } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  rendererListeners: new Map<string, (...args: unknown[]) => unknown>(),
  pendingOpen: {
    path: '',
    started: Promise.withResolvers<void>(),
    finish: Promise.withResolvers<{ close: () => Promise<void>; read: () => never }>()
  }
}))

const sender = {
  id: 1,
  mainFrame: {},
  isDestroyed: () => false,
  on: vi.fn(),
  once: vi.fn(),
  send: (channel: string, response: unknown) => rendererListeners.get(channel)?.({}, response)
}

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: vi.fn() },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    on: (channel: string, listener: (...args: unknown[]) => unknown) =>
      listeners.set(channel, listener),
    removeAllListeners: vi.fn(),
    removeHandler: vi.fn()
  },
  ipcRenderer: {
    invoke: async (channel: string, args: unknown) =>
      handlers.get(channel)?.({ sender, senderFrame: sender.mainFrame }, args),
    send: (channel: string, args: unknown) => listeners.get(channel)?.({ sender }, args),
    on: (channel: string, listener: (...args: unknown[]) => unknown) =>
      rendererListeners.set(channel, listener),
    removeListener: (channel: string) => rendererListeners.delete(channel)
  }
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof FsPromisesModule>()
  return {
    ...fs,
    open: (...args: Parameters<typeof fs.open>) => {
      if (args[0] !== pendingOpen.path) {
        return fs.open(...args)
      }
      pendingOpen.started.resolve()
      return pendingOpen.finish.promise
    }
  }
})

import { registerRuntimeHandlers } from '../../../main/ipc/runtime'
import { runtimeApi } from '../../../preload/api/runtime-bridge'
import { callRuntimeRpc } from './rpc/calls/runtime-rpc-call'

afterEach(() => vi.unstubAllGlobals())

it('releases a transcript handle opened after the local RPC caller cancels', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orca-local-rpc-cancel-'))
  try {
    pendingOpen.path = join(directory, 'transcript.jsonl')
    await writeFile(pendingOpen.path, '{}\n')
    const runtime = {
      getRuntimeId: () => 'runtime',
      getAgentProviderSessionRows: () => [],
      cleanupSubscriptionsForConnection: vi.fn()
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this read only uses the runtime identity, provider rows, and subscription cleanup.
    registerRuntimeHandlers(runtime as never)
    vi.stubGlobal('window', { api: { runtime: runtimeApi } })
    const controller = new AbortController()
    const request = callRuntimeRpc(
      { kind: 'local' },
      'nativeChat.readSession',
      {
        agent: 'codex',
        sessionId: 'conversation',
        transcriptPath: pendingOpen.path
      },
      { signal: controller.signal }
    )
    const rejection = expect(request).rejects.toMatchObject({ name: 'AbortError' })
    await pendingOpen.started.promise
    controller.abort()
    await rejection
    const closed = Promise.withResolvers<void>()
    pendingOpen.finish.resolve({
      close: async () => closed.resolve(),
      read: () => {
        throw new Error('Cancelled transcript must not start reading')
      }
    })
    await closed.promise
    expect(rendererListeners.size).toBe(0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
