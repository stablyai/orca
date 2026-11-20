import { beforeEach, expect, it, vi } from 'vitest'
import { prepareAgentImagePaths } from './agent-image-preparation'

type PreparedImageSubscription = {
  onEvent: (value: unknown) => void
  onError: (error: unknown) => void
  unsubscribe: ReturnType<typeof vi.fn>
}
const transport = vi.hoisted((): { opened: PreparedImageSubscription[] } => ({ opened: [] }))
vi.mock('../rpc/subscriptions/runtime-rpc-subscribe', () => ({
  subscribeRuntimeRpc: vi.fn(async (_target, _method, _params, handlers) => {
    const unsubscribe = vi.fn()
    transport.opened.push({ ...handlers, unsubscribe })
    return { unsubscribe }
  })
}))
vi.mock('../hosted-terminals/identity/remote-runtime-pty-owner', () => ({
  getRemoteRuntimePtyOwner: () => null
}))
vi.mock('@/store/index', () => ({ useAppStore: { subscribe: () => () => {} } }))
beforeEach(() => {
  transport.opened = []
})

it.each([10, 100])(
  'cancels %i pending image preparations and lets a surviving send complete',
  async (count) => {
    const controller = new AbortController()
    const pending = Array.from({ length: count }, () =>
      prepareAgentImagePaths('pty-1', ['/shot.png'], undefined, { signal: controller.signal })
    )
    const cancelled = Promise.allSettled(pending)
    controller.abort()
    const results = await cancelled
    expect(results.every((result) => result.status === 'rejected')).toBe(true)
    expect(
      transport.opened.filter((request) => request.unsubscribe.mock.calls.length === 1)
    ).toHaveLength(count)
    const survivor = prepareAgentImagePaths('pty-1', ['/next.png'])
    transport.opened.at(-1)!.onEvent({ paths: ['/fit.png'] })
    await expect(survivor).resolves.toEqual(['/fit.png'])
  }
)

it('keeps image sends working with older hosts and never reads legacy SSH paths on the desktop', async () => {
  const older = prepareAgentImagePaths('pty-1', ['/small.png'])
  transport.opened.at(-1)!.onError({ code: 'method_not_found' })
  await expect(older).resolves.toEqual(['/small.png'])
  await expect(prepareAgentImagePaths('ssh:target@@pty-1', ['/remote.png'])).resolves.toEqual([
    '/remote.png'
  ])
})
