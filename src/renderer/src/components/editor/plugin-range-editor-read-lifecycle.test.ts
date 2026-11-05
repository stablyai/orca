import { expect, it } from 'vitest'
import { RuntimeRangeDocument, type RangeDocumentTransport } from '@/runtime/runtime-range-document'
import { createCustomEditorHost } from './plugin-custom-editor-host'
import { createPluginFrameSendBudget } from '../../../../preload/plugin-frame-guest-send-budget'
import { isPluginJsonObject } from '../../../../shared/plugins/manifest/plugin-json-object'

it('settles cancelled and invalidated reads so the preload admits new reads after explicit reload', async () => {
  const descriptor = {
    id: 'file',
    version: 1,
    byteLength: 2,
    maxReadBytes: 262144,
    readOnly: true as const,
    isBinary: true,
    valid: true
  }
  let release = Promise.withResolvers<void>()
  const transport: RangeDocumentTransport = {
    open: async () => descriptor,
    read: async ({ version, offset }) => {
      await release.promise
      return {
        version,
        contentBase64: offset === 0 ? 'AA==' : 'QQ==',
        bytesRead: 1,
        eof: offset === 1
      }
    },
    reload: async () => ({ ...descriptor, version: 2 }),
    status: async () => descriptor,
    close: async () => {},
    cancel: async () => {}
  }
  const source = new RuntimeRangeDocument(descriptor, transport)
  const admit = createPluginFrameSendBudget()
  const responses = new Map<number, ReturnType<typeof Promise.withResolvers<unknown>>>()
  const frameWindow = {
    postMessage: (message: unknown) => {
      admit.settle(message)
      if (isPluginJsonObject(message) && message.kind === 'res' && typeof message.id === 'number')
        responses.get(message.id)?.resolve(message)
    }
  }
  const host = createCustomEditorHost({
    getFrameWindow: () => frameWindow,
    getDocument: () => ({ text: '', readOnly: true }),
    onEdit: () => {},
    rangeDocument: { source, fileType: 'bin' }
  })
  host.channel.onReady()
  const request = (id: number, offset = 0, version = 1) => ({
    orca: 1,
    kind: 'req',
    id,
    method: 'editor.readRange',
    params: { version, offset, length: 1 }
  })
  const send = (message: ReturnType<typeof request>) => {
    responses.set(message.id, Promise.withResolvers<unknown>())
    expect(admit(message)).toBeNull()
    host.channel.claim(message)
    return responses.get(message.id)!.promise
  }
  try {
    const first = send(request(1))
    const second = send(request(2, 1))
    host.channel.claim({ orca: 1, kind: 'cancel', id: 1 })
    host.channel.claim({ orca: 1, kind: 'cancel', id: 2 })
    expect(admit(request(3))).toMatchObject({ code: 'rate_limited' })
    release.resolve()
    await expect(first).resolves.toMatchObject({ error: { code: 'cancelled' } })
    await expect(second).resolves.toMatchObject({ error: { code: 'cancelled' } })
    await expect(send(request(3, 1))).resolves.toMatchObject({ result: { version: 1, eof: true } })
    release = Promise.withResolvers<void>()
    const invalidated = send(request(4))
    source.invalidate()
    await expect(send(request(5))).resolves.toMatchObject({ error: { code: 'action_failed' } })
    release.resolve()
    await expect(invalidated).resolves.toMatchObject({ error: { code: 'cancelled' } })
    const next = await source.reload()
    const result = await send(request(6, 1, next.version))
    expect(result).toMatchObject({ result: { version: 2, eof: true } })
    const payload =
      isPluginJsonObject(result) && isPluginJsonObject(result.result) ? result.result.bytes : null
    expect(payload instanceof ArrayBuffer && [...new Uint8Array(payload)]).toEqual([65])
  } finally {
    release.resolve()
    host.reset()
    source.dispose()
  }
})
