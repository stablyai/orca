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

// The explorer's view of the host directory: whatever the last catch-up re-read saw.
function hostDirectory(): {
  host: Set<string>
  shown: Set<string>
  onCatchUp: () => void
} {
  const host = new Set<string>()
  const shown = new Set<string>()
  return {
    host,
    shown,
    onCatchUp: () => {
      shown.clear()
      host.forEach((name) => shown.add(name))
    }
  }
}
function streamCallback(call: number, index: 2 | 3): (error?: Error) => void {
  const callback: unknown = runtime.subscribe.mock.calls[call]?.[index]
  if (typeof callback !== 'function') {
    throw new Error(`stream ${call} registered no ${index === 2 ? 'error' : 'ready'} callback`)
  }
  return (error) => callback(error)
}

describe('editor runtime file watch recovery', () => {
  it('disposes late old stream handles without replacing the current handle', async () => {
    const old = pendingSubscription()
    const fresh = pendingSubscription()
    const stopOld = vi.fn()
    const stopFresh = vi.fn()
    const onCatchUp = vi.fn()
    runtime.subscribe.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise)
    const stop = subscribeEditorRuntimeFileWatch(target, vi.fn(), vi.fn(), onCatchUp)
    runtime.contact.get('host-a')?.()
    fresh.resolve(stopFresh)
    await settle()
    old.resolve(stopOld)
    await settle()
    expect(stopOld).toHaveBeenCalledOnce()
    expect(stopFresh).not.toHaveBeenCalled()
    expect(onCatchUp).toHaveBeenCalledOnce()
    stop()
    expect(stopFresh).toHaveBeenCalledOnce()
  })

  it('shows files written before the host watcher was installed', async () => {
    const dir = hostDirectory()
    runtime.subscribe.mockResolvedValue(vi.fn())
    subscribeEditorRuntimeFileWatch(target, vi.fn(), vi.fn(), dir.onCatchUp)
    await settle()
    dir.host.add('BEFORE_FIRST_READY.txt')
    streamCallback(0, 3)()
    expect([...dir.shown]).toEqual(['BEFORE_FIRST_READY.txt'])

    runtime.contact.get('host-a')?.()
    dir.host.add('DURING_OUTAGE.txt')
    await settle()
    // Install can stay pending on the restarted host, so outage changes must not wait for it.
    expect(dir.shown.has('DURING_OUTAGE.txt')).toBe(true)
    dir.host.add('BEFORE_RECOVERED_READY.txt')
    streamCallback(1, 3)()
    expect(dir.shown.has('BEFORE_RECOVERED_READY.txt')).toBe(true)
  })

  it('re-reads once more when the recovered host watcher fails to install', async () => {
    const dir = hostDirectory()
    const onError = vi.fn()
    runtime.subscribe.mockResolvedValue(vi.fn())
    subscribeEditorRuntimeFileWatch(target, vi.fn(), onError, dir.onCatchUp)
    runtime.contact.get('host-a')?.()
    await settle()
    dir.host.add('BEFORE_INSTALL_FAILED.txt')
    const failure = new Error('watcher capacity')
    streamCallback(1, 2)(failure)
    expect([...dir.shown]).toEqual(['BEFORE_INSTALL_FAILED.txt'])
    expect(onError).toHaveBeenCalledWith(failure)
  })
})
