import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangedPayload } from '../../../shared/file-watch/filesystem-change-event'
import { subscribeEditorRuntimeFileWatch } from './editor-runtime-file-watch'

const runtime = vi.hoisted(() => ({
  subscribe: vi.fn(),
  contact: new Map<string, () => void>(),
  retire: new Set<(ids: readonly string[]) => void>(),
  stopContact: vi.fn(),
  stopRetirement: vi.fn(),
  payloads: new Array<(payload: FsChangedPayload) => void>(),
  errors: new Array<(error: Error) => void>()
}))
vi.mock('@/runtime/files/watching/runtime-file-watch-client', () => ({
  subscribeRuntimeFileChanges: runtime.subscribe
}))
vi.mock('@/runtime/hosts/connections/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (id: string, listener: () => void) => {
    runtime.contact.set(id, listener)
    return runtime.stopContact
  }
}))
vi.mock('@/runtime/rpc/environment-revisions/runtime-environment-revision', () => ({
  onRuntimeEnvironmentsRetired: (listener: (ids: readonly string[]) => void) => {
    runtime.retire.add(listener)
    return runtime.stopRetirement
  }
}))

const target = {
  worktreeId: 'wt',
  worktreePath: '/repo',
  connectionId: undefined,
  runtimeEnvironmentId: 'host-a'
}
function pendingSubscription(): {
  promise: Promise<() => void>
  resolve: (stop: () => void) => void
} {
  let resolve: (stop: () => void) => void = () => {}
  const promise = new Promise<() => void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

beforeEach(() => {
  vi.clearAllMocks()
  runtime.contact.clear()
  runtime.retire.clear()
  runtime.payloads.length = 0
  runtime.errors.length = 0
  runtime.subscribe.mockReset()
})

describe('editor runtime file watch recovery', () => {
  it('disposes late old stream handles without replacing the current handle', async () => {
    const old = pendingSubscription()
    const fresh = pendingSubscription()
    const stopOld = vi.fn()
    const stopFresh = vi.fn()
    const onPayload = vi.fn()
    runtime.subscribe.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const stop = subscribeEditorRuntimeFileWatch(target, onPayload, vi.fn())
    runtime.contact.get('host-a')?.()
    fresh.resolve(stopFresh)
    await settle()
    old.resolve(stopOld)
    await settle()
    expect(stopOld).toHaveBeenCalledOnce()
    expect(stopFresh).not.toHaveBeenCalled()
    // An accepted subscription is not an installed host watcher; resyncing earlier loses writes in between.
    expect(onPayload).not.toHaveBeenCalled()
    const freshReady: unknown = runtime.subscribe.mock.calls[1]?.[3]
    if (typeof freshReady !== 'function') {
      throw new Error('fresh stream registered no ready callback')
    }
    freshReady()
    expect(onPayload).toHaveBeenCalledOnce()
    expect(onPayload).toHaveBeenCalledWith({
      worktreePath: '/repo',
      events: [{ kind: 'overflow', absolutePath: '/repo' }],
      resync: true
    })
    stop()
    expect(stopFresh).toHaveBeenCalledOnce()
  })

  it('still re-reads once when the recovered host watcher fails to install', async () => {
    const onPayload = vi.fn()
    const onError = vi.fn()
    runtime.subscribe.mockResolvedValue(vi.fn())
    subscribeEditorRuntimeFileWatch(target, onPayload, onError)
    runtime.contact.get('host-a')?.()
    await settle()
    const freshError: unknown = runtime.subscribe.mock.calls[1]?.[2]
    if (typeof freshError !== 'function') {
      throw new Error('fresh stream registered no error callback')
    }
    freshError(new Error('watcher capacity'))
    freshError(new Error('watcher capacity'))
    expect(onPayload).toHaveBeenCalledOnce()
    expect(onPayload).toHaveBeenCalledWith(expect.objectContaining({ resync: true }))
    expect(onError).toHaveBeenCalledTimes(2)
  })
})
