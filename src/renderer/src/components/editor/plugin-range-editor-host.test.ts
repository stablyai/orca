import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RangedFileDocuments } from '../../../../main/ipc/filesystem/ranged-file-documents'
import { expect, it } from 'vitest'
import { RuntimeRangeDocument, type RangeDocumentTransport } from '@/runtime/runtime-range-document'
import { createCustomEditorHost } from './plugin-custom-editor-host'
import { isPluginJsonObject } from '../../../../shared/plugins/manifest/plugin-json-object'

it('refuses guest file addresses and edits while reading only its bound document', async () => {
  const descriptor = {
    id: 'host-only',
    version: 3,
    byteLength: 3,
    maxReadBytes: 262144,
    readOnly: true as const,
    isBinary: true,
    valid: true
  }
  const transport: RangeDocumentTransport = {
    open: async () => descriptor,
    read: async (params) => {
      if (params.id !== 'host-only') {
        throw new Error('Wrong document authority')
      }
      return { version: 3, contentBase64: 'FiE=', bytesRead: 2, eof: true }
    },
    reload: async () => descriptor,
    status: async () => descriptor,
    close: async () => {},
    cancel: async () => {}
  }
  const source = new RuntimeRangeDocument(descriptor, transport)
  const responses = new Map<number, (response: unknown) => void>()
  const window = {
    postMessage(message: unknown) {
      if (isPluginJsonObject(message) && message.kind === 'res' && typeof message.id === 'number') {
        responses.get(message.id)?.(message)
      }
    }
  }
  const host = createCustomEditorHost({
    getFrameWindow: () => window,
    getDocument: () => ({ text: '', readOnly: true }),
    onEdit: () => {
      throw new Error('A ranged document cannot be edited')
    },
    rangeDocument: { source, fileType: 'bin' }
  })
  host.channel.onReady()
  const request = (id: number, method: string, params?: unknown): Promise<unknown> =>
    new Promise((resolve) => {
      responses.set(id, resolve)
      expect(host.channel.claim({ orca: 1, kind: 'req', id, method, params })).toBe(true)
    })
  try {
    await expect(request(1, 'editor.rangeSession')).resolves.toEqual({
      orca: 1,
      kind: 'res',
      id: 1,
      result: { version: 3, byteLength: 3, maxReadBytes: 262144, readOnly: true, fileType: 'bin' }
    })
    await expect(
      request(2, 'editor.readRange', {
        version: 3,
        offset: 1,
        length: 2,
        id: 'other',
        filePath: '/secret'
      })
    ).resolves.toMatchObject({ error: { code: 'invalid_params' } })
    await expect(
      request(3, 'editor.applyEdit', {
        baseVersion: 3,
        content: { kind: 'bytes', bytes: new ArrayBuffer(1) }
      })
    ).resolves.toMatchObject({ error: { code: 'not_permitted' } })
    const response = await request(4, 'editor.readRange', { version: 3, offset: 1, length: 2 })
    expect(response).toMatchObject({ result: { version: 3, eof: true } })
    const result = isPluginJsonObject(response) ? response.result : null
    expect(
      isPluginJsonObject(result) &&
        result.bytes instanceof ArrayBuffer && [...new Uint8Array(result.bytes)]
    ).toEqual([22, 33])
  } finally {
    host.reset()
    source.dispose()
  }
})

it('keeps deleted-file paths out of guest reload failures and requires explicit reload after close', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'orca-secret-range-'))
  const path = join(folder, 'private-document.bin')
  const documents = new RangedFileDocuments()
  const owner = 'frame-host'
  await writeFile(path, new Uint8Array([0, 22, 33]))
  const transport: RangeDocumentTransport = {
    open: () => documents.open(owner, async () => path),
    read: (params, signal) => documents.read(owner, params, signal),
    reload: ({ id }) => documents.reload(owner, id),
    status: ({ id }) => documents.status(owner, id),
    close: ({ id }) => documents.close(owner, id),
    cancel: async ({ id, requestToken }) => documents.cancel(owner, id, requestToken)
  }
  const source = new RuntimeRangeDocument(await transport.open(), transport)
  const messages = new Map<number, (value: unknown) => void>()
  const frameWindow = {
    postMessage: (value: unknown) => {
      if (isPluginJsonObject(value) && value.kind === 'res' && typeof value.id === 'number') {
        messages.get(value.id)?.(value)
      }
    }
  }
  const host = createCustomEditorHost({
    getFrameWindow: () => frameWindow,
    getDocument: () => ({ text: '', readOnly: true }),
    onEdit: () => {},
    rangeDocument: { source, fileType: 'bin' }
  })
  const request = (id: number, method: string) =>
    new Promise<unknown>((resolve) => {
      messages.set(id, resolve)
      host.channel.claim({ orca: 1, kind: 'req', id, method })
    })
  try {
    host.channel.onReady()
    source.close()
    await source.bind()
    await expect(source.read({ version: 1, offset: 0, length: 1 })).rejects.toThrow(
      'Reload explicitly'
    )
    const reloaded = await source.reload()
    expect(reloaded.version).toBe(2)
    const byte = await source.read({ version: 2, offset: 1, length: 1 })
    expect([...new Uint8Array(byte.bytes)]).toEqual([22])
    await rm(path)
    const failure = await request(1, 'editor.reloadRanges')
    expect(failure).toMatchObject({
      error: {
        code: 'action_failed',
        message: 'The document operation failed. Check access and reload explicitly.'
      }
    })
    expect(JSON.stringify(failure)).not.toContain(folder)
    expect(JSON.stringify(failure)).not.toContain('private-document.bin')
  } finally {
    host.reset()
    source.dispose()
    await documents.closeOwner(owner)
    await rm(folder, { recursive: true, force: true })
  }
})
