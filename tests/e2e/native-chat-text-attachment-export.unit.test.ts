// @vitest-environment happy-dom
import { createElement } from 'react'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatTextAttachmentPreview } from '@/components/native-chat/NativeChatTextAttachmentPreview'
import { AgentSessionAttachmentStore } from '../../src/main/native-chat/agent-session-attachments/agent-session-attachment-store'
import { createFilesystemHandlerContext } from '../../src/main/ipc/filesystem/filesystem-handler-context'
import { registerFilesystemDownloadHandlers } from '../../src/main/ipc/filesystem/filesystem-download-handlers'
import type { Store } from '../../src/main/persistence/loading-store/store'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  dialog: vi.fn(),
  write: vi.fn(),
  rpc: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: mocks.dialog },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: mocks.rpc }))
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }))
afterEach(cleanup)

it('saves zero-byte and invalid UTF8 committed files through the real native sink and copies empty text', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'export35636-'))
  const sourceStore = new AgentSessionAttachmentStore(join(folder, 'agent-session-attachments'), {
    hasSession: () => true
  })
  // SAFETY: only download handlers are registered; they do not access persistence.
  const store: Store = Object.create(null)
  const cancellations = { begin: () => null, finish: () => {}, cancel: () => {} }
  const context = createFilesystemHandlerContext(store, undefined, cancellations, cancellations)
  registerFilesystemDownloadHandlers(context)
  const sender = Object.assign(new EventEmitter(), { id: 35636, isDestroyed: () => false })
  const invoke = (name: string, args: unknown) => {
    const handler = mocks.handlers.get(`fs:${name}`)
    if (!handler) {
      throw new Error(`Missing ${name}`)
    }
    return handler({ sender }, args)
  }
  const append = vi.fn((args: unknown) => invoke('appendDownloadedFileChunk', args))
  const finish = vi.fn((args: unknown) => invoke('finishDownloadedFile', args))
  const cancel = vi.fn((args: unknown) => invoke('cancelDownloadedFile', args))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      ui: { writeClipboardText: mocks.write },
      fs: {
        startDownloadedFile: (args: unknown) => invoke('startDownloadedFile', args),
        appendDownloadedFileChunk: append,
        finishDownloadedFile: finish,
        cancelDownloadedFile: cancel
      }
    }
  })
  mocks.rpc.mockImplementation(async (_target, method, request) =>
    method === 'status.get'
      ? { runtimeId: '35636', capabilities: ['native-chat.text-attachment-read.v1'] }
      : sourceStore.readTextChunk(request)
  )
  try {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0xff, 0, 0x80])]) {
      const name = bytes.length ? 'invalid.txt' : 'empty.txt'
      const { uploadId } = await sourceStore.startUpload({
        callerKey: '35636',
        sessionId: 's',
        name,
        byteLength: bytes.length
      })
      if (bytes.length) {
        await sourceStore.appendChunk({
          callerKey: '35636',
          uploadId,
          offset: 0,
          contentBase64: bytes.toString('base64')
        })
      }
      const { path } = await sourceStore.commitUpload({ callerKey: '35636', uploadId })
      const destination = join(folder, name)
      mocks.dialog.mockResolvedValue({ canceled: false, filePath: destination })
      append.mockClear()
      finish.mockClear()
      cancel.mockClear()
      const view = render(
        createElement(NativeChatTextAttachmentPreview, {
          path,
          target: { kind: 'local' },
          onClose: () => {}
        })
      )
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Save file' }).hasAttribute('disabled')).toBe(
          false
        )
      )
      if (!bytes.length) {
        fireEvent.click(screen.getByRole('button', { name: 'Copy contents' }))
        await waitFor(() => expect(mocks.write).toHaveBeenCalledWith(''))
        await waitFor(() =>
          expect(screen.getByRole('button', { name: 'Save file' }).hasAttribute('disabled')).toBe(
            false
          )
        )
      }
      fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
      await waitFor(() => expect(finish).toHaveBeenCalledOnce())
      await waitFor(() => expect(context.downloadSessions.size).toBe(0))
      expect(await readFile(destination)).toEqual(bytes)
      expect(append).toHaveBeenCalledTimes(bytes.length ? 1 : 0)
      expect(cancel).not.toHaveBeenCalled()
      view.unmount()
    }
  } finally {
    for (const id of context.downloadSessions.keys()) {
      await context.closeDownloadSession(id, true)
    }
    sourceStore.clearInFlightForTests()
    await rm(folder, { recursive: true, force: true })
  }
})
