import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Store } from '../../src/main/persistence'
import * as requests from '@/store/github/actions-artifact-requests'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  showSaveDialog: vi.fn()
}))
vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: mocks.showSaveDialog },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler)
  }
}))
vi.mock('../../src/main/ipc/filesystem-download-folder', () => ({
  registerFilesystemDownloadFolderHandlers: vi.fn()
}))
vi.mock('../../src/main/providers/ssh-filesystem-dispatch', () => ({
  requireSshFilesystemProvider: vi.fn()
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))
vi.mock('@/store/github/actions-artifact-requests', () => ({
  startActionsArtifactDownload: vi.fn(),
  readActionsArtifactChunk: vi.fn(),
  releaseActionsArtifactDownload: vi.fn()
}))

import { createFilesystemHandlerContext } from '../../src/main/ipc/filesystem/filesystem-handler-context'
import { registerFilesystemDownloadHandlers } from '../../src/main/ipc/filesystem/filesystem-download-handlers'
import { downloadActionsArtifact } from '../../src/renderer/src/components/task-page/github/actions/download-actions-artifact'

// A stored, nonempty ZIP containing only inert hello.txt; never extracted or executed.
const archive = Buffer.from(
  'UEsDBBQAAAAAAAAAIVwCDJr/IwAAACMAAAAJAAAAaGVsbG8udHh0SGVsbG8gZnJvbSB0aGUgT3JjYSBtb2NrIGFydGlmYWN0LgpQSwECFAMUAAAAAAAAACFcAgya/yMAAAAjAAAACQAAAAAAAAAAAAAAgAEAAAAAaGVsbG8udHh0UEsFBgAAAAABAAEANwAAAEoAAAAAAA==',
  'base64'
)
const repository = { owner: 'acme', repo: 'widgets', host: 'github.com' }
const context = { repoId: 'fixture', repoPath: '/fixture' }
const query = { repository, runId: 900, artifactId: 7 }
const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false })
let directory: string
let destination: string
let filesystem: ReturnType<typeof createFilesystemHandlerContext>

function invoke(name: string, args: unknown) {
  const handler = mocks.handlers.get(`fs:${name}`)
  if (!handler) {
    throw new Error(`Missing handler ${name}`)
  }
  return handler({ sender }, args)
}

beforeEach(async () => {
  vi.resetAllMocks()
  directory = await mkdtemp(join(tmpdir(), 'orca-artifact-integration-'))
  destination = join(directory, 'hello.zip')
  mocks.showSaveDialog.mockResolvedValue({ canceled: false, filePath: destination })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Only download handlers are registered, and they never access the store.
  const store = {} as Store
  const cancellations = { begin: () => null, finish: () => {}, cancel: () => {} }
  filesystem = createFilesystemHandlerContext(store, undefined, cancellations, cancellations)
  registerFilesystemDownloadHandlers(filesystem)
  vi.stubGlobal('window', {
    api: {
      fs: {
        startDownloadedFile: (args: unknown) => invoke('startDownloadedFile', args),
        appendDownloadedFileChunk: (args: unknown) => invoke('appendDownloadedFileChunk', args),
        finishDownloadedFile: (args: unknown) => invoke('finishDownloadedFile', args),
        cancelDownloadedFile: (args: unknown) => invoke('cancelDownloadedFile', args)
      }
    }
  })
  vi.mocked(requests.startActionsArtifactDownload).mockResolvedValue({
    transferId: 'remote',
    sizeBytes: archive.length,
    fileName: 'hello.zip'
  })
  vi.mocked(requests.readActionsArtifactChunk).mockImplementation(
    async (_state, _context, args) => {
      const nextOffset = Math.min(args.offset + 50, archive.length)
      return {
        contentBase64: archive.subarray(args.offset, nextOffset).toString('base64'),
        nextOffset,
        done: nextOffset === archive.length
      }
    }
  )
  vi.mocked(requests.releaseActionsArtifactDownload).mockResolvedValue(undefined)
})

afterEach(async () => {
  await Promise.all(
    [...filesystem.downloadSessions.keys()].map((id) => filesystem.closeDownloadSession(id, true))
  )
  await rm(directory, { recursive: true, force: true })
  sender.removeAllListeners()
  vi.unstubAllGlobals()
})

it('saves exact nonempty ZIP bytes through real disk staging and reports multi-chunk progress', async () => {
  const progress = vi.fn()
  await expect(
    downloadActionsArtifact(context, query, 'hello', () => true, progress)
  ).resolves.toBe(destination)
  expect(await readFile(destination)).toEqual(archive)
  expect(await readdir(directory)).toEqual(['hello.zip'])
  expect(progress.mock.calls.map(([percent]) => percent)).toEqual([33, 66, 99, 100])
  expect(filesystem.downloadSessions.size).toBe(0)
  expect(requests.releaseActionsArtifactDownload).toHaveBeenCalledOnce()
  expect(mocks.showSaveDialog).toHaveBeenCalledWith({ defaultPath: 'hello.zip' })
})

it('save-dialog cancel requests no archive and creates no file', async () => {
  mocks.showSaveDialog.mockResolvedValue({ canceled: true })
  await expect(
    downloadActionsArtifact(context, query, 'hello', () => true, vi.fn())
  ).resolves.toBeNull()
  expect(requests.startActionsArtifactDownload).not.toHaveBeenCalled()
  expect(await readdir(directory)).toEqual([])
  expect(filesystem.downloadSessions.size).toBe(0)
})

it('active cancellation removes partial bytes and preserves an existing destination', async () => {
  const existing = Buffer.from('existing destination')
  await writeFile(destination, existing)
  let live = true
  const progress = vi.fn(() => {
    live = false
  })
  await expect(
    downloadActionsArtifact(context, query, 'hello', () => live, progress)
  ).rejects.toThrow('Artifact download canceled')
  expect(await readFile(destination)).toEqual(existing)
  expect(await readdir(directory)).toEqual(['hello.zip'])
  expect(requests.readActionsArtifactChunk).toHaveBeenCalledOnce()
  expect(requests.releaseActionsArtifactDownload).toHaveBeenCalledOnce()
  expect(filesystem.downloadSessions.size).toBe(0)
})

it.each([
  'HTTP 403 authorization required',
  'HTTP 404 artifact not found',
  'Network connection reset'
])('cleans real local staging after a remote start failure: %s', async (message) => {
  vi.mocked(requests.startActionsArtifactDownload).mockRejectedValue(new Error(message))
  await expect(
    downloadActionsArtifact(context, query, 'hello', () => true, vi.fn())
  ).rejects.toThrow(message)
  expect(await readdir(directory)).toEqual([])
  expect(filesystem.downloadSessions.size).toBe(0)
  expect(requests.readActionsArtifactChunk).not.toHaveBeenCalled()
})

it('cleans partial disk bytes and releases remote transfer after a chunk network error', async () => {
  vi.mocked(requests.readActionsArtifactChunk)
    .mockResolvedValueOnce({
      contentBase64: archive.subarray(0, 50).toString('base64'),
      nextOffset: 50,
      done: false
    })
    .mockRejectedValueOnce(new Error('Network connection reset'))
  await expect(
    downloadActionsArtifact(context, query, 'hello', () => true, vi.fn())
  ).rejects.toThrow('Network connection reset')
  expect(await readdir(directory)).toEqual([])
  expect(filesystem.downloadSessions.size).toBe(0)
  expect(requests.releaseActionsArtifactDownload).toHaveBeenCalledOnce()
})
