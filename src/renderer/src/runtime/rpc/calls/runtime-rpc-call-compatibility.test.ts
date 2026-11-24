// A background call's cold compatibility probe is background too: it must not count as use of an
// idle host or wake one (#46567).
import { afterEach, expect, it, vi } from 'vitest'

const environment = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('./runtime-rpc-environment-call', () => ({
  callRuntimeEnvironmentWithRevision: environment.call
}))
vi.mock('../compatibility/runtime-protocol-compat', () => ({
  assertRuntimeStatusCompatible: () => {},
  isRuntimeStatusCompatible: () => true
}))
vi.mock('../environment-revisions/runtime-environment-revision', () => ({
  captureRuntimeEnvironmentRequestRevision: () => undefined
}))

afterEach(() => {
  environment.call.mockReset()
})

it('carries background and no-wake intent into the cold status probe', async () => {
  const { callRuntimeRpc } = await import('./runtime-rpc-call')
  environment.call.mockImplementation(async ({ method }: { method: string }) =>
    method === 'status.get'
      ? { ok: true, result: { runtimeId: 'r1', capabilities: [] } }
      : { ok: true, result: { autoStash: true } }
  )
  await callRuntimeRpc(
    { kind: 'environment', environmentId: 'env-cold' },
    'git.rebaseAutoStash',
    { worktree: 'id:wt' },
    { background: true, wake: false }
  )
  const probe = environment.call.mock.calls.find(([args]) => args.method === 'status.get')?.[0]
  const final = environment.call.mock.calls.find(([args]) => args.method !== 'status.get')?.[0]
  expect(probe).toMatchObject({ background: true, wake: false })
  expect(final).toMatchObject({ background: true, wake: false })
})
