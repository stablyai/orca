// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import { captureGitHubImageUpload } from './github-image-upload'
import { callAbortableGitHubImageUpload } from './github-image-upload-local-call'
import type { RuntimeRpcResponse } from '../../../../shared/runtime-rpc-envelope'
import { GITHUB_IMAGE_ATTACHMENT_CAPABILITY } from '../../../../shared/github/attachments/image-attachment'

const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: call }))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  getRuntimeEnvironmentRevision: () => 1
}))
vi.mock('@/app-shell/platform/web-client-location', () => ({ isWebClientLocation: () => false }))
vi.mock('@/web/web-runtime-environment', () => ({ readStoredWebRuntimeEnvironment: () => null }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  call.mockReset()
})
const address = {
  runtime: { kind: 'local' as const },
  target: { kind: 'repo' as const, repo: 'repo', source: 'origin' as const }
}
const file = () => new File(['image'], 'image.png', { type: 'image/png' })
const ok = (result: unknown): RuntimeRpcResponse<unknown> => ({
  id: 'request',
  ok: true,
  result,
  _meta: { runtimeId: 'local' }
})
function bridge(subscribe: unknown) {
  vi.stubGlobal('window', { api: { runtime: { subscribe } } })
}

it('releases a late staging ID after retirement without admitting a chunk or POST', async () => {
  const allocation = Promise.withResolvers<{ uploadId: string }>()
  call.mockImplementation((_runtime, method) =>
    method === 'clipboard.startImageUpload' ? allocation.promise : Promise.resolve()
  )
  const subscribe = vi.fn((_args, reply) => {
    reply(ok({ capabilities: [GITHUB_IMAGE_ATTACHMENT_CAPABILITY] }))
    return Promise.resolve({ unsubscribe: vi.fn() })
  })
  bridge(subscribe)
  const controller = new AbortController()
  const pending = captureGitHubImageUpload(address)(file(), controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() =>
    expect(call).toHaveBeenCalledWith(
      address.runtime,
      'clipboard.startImageUpload',
      expect.anything(),
      expect.anything()
    )
  )
  controller.abort()
  allocation.resolve({ uploadId: 'late' })
  await rejected
  expect(call.mock.calls.map((args) => args[1])).toEqual([
    'clipboard.startImageUpload',
    'clipboard.abortImageUpload'
  ])
  expect(call.mock.calls[1][2]).toEqual({ uploadId: 'late' })
  expect(call.mock.calls[1][3].signal).toBeUndefined()
  expect(subscribe.mock.calls.map(([args]) => args.method)).toEqual(['status.get'])
})

it('unsubscribes an active local upload and allows a live successor to finish', async () => {
  call.mockImplementation((_runtime, method) =>
    Promise.resolve(method === 'clipboard.startImageUpload' ? { uploadId: 'staged' } : undefined)
  )
  let active: AbortController | undefined
  let cancelFirst = true
  const subscribe = vi.fn((args, reply) => {
    const host = new AbortController()
    const unsubscribe = () => host.abort()
    if (args.method === 'status.get') {
      reply(ok({ capabilities: [GITHUB_IMAGE_ATTACHMENT_CAPABILITY] }))
    } else if (args.method === 'github.uploadAttachment' && cancelFirst) {
      active = host
    } else {
      reply(
        ok(
          args.method === 'github.uploadAttachment'
            ? { url: 'https://github.com/user-attachments/assets/success' }
            : undefined
        )
      )
    }
    return Promise.resolve({ unsubscribe })
  })
  bridge(subscribe)
  const controller = new AbortController()
  const pending = captureGitHubImageUpload(address)(file(), controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  await vi.waitFor(() => expect(active).toBeDefined())
  controller.abort()
  await rejected
  expect(active?.signal.aborted).toBe(true)
  cancelFirst = false
  await expect(
    captureGitHubImageUpload(address)(file(), new AbortController().signal)
  ).resolves.toBe('https://github.com/user-attachments/assets/success')
})

it.each(['abort', 'response'])(
  'unsubscribes when %s settles before the local handle arrives',
  async (outcome) => {
    const setup = Promise.withResolvers<{ unsubscribe: () => void; sendBinary: () => void }>()
    let reply: ((value: RuntimeRpcResponse<unknown>) => void) | undefined
    bridge(
      vi.fn((_args, callback) => {
        reply = callback
        return setup.promise
      })
    )
    const controller = new AbortController()
    const pending = callAbortableGitHubImageUpload('status.get', undefined, controller.signal)
    if (outcome === 'abort') {
      const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
      controller.abort()
      await rejected
    } else {
      reply?.(ok('complete'))
      await expect(pending).resolves.toBe('complete')
    }
    const unsubscribe = vi.fn()
    setup.resolve({ unsubscribe, sendBinary: vi.fn() })
    await setup.promise
    await Promise.resolve()
    expect(unsubscribe).toHaveBeenCalledTimes(1)
  }
)
