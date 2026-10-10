import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FsChangedPayload } from '../../../shared/filesystem-entry-types'
import { subscribeEditorRuntimeFileWatch } from './editor-runtime-file-watch'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

const runtime = vi.hoisted(() => ({
  subscribe: vi.fn(),
  contact: new Map<string, () => void>(),
  retire: new Set<(ids: readonly string[]) => void>(),
  stopContact: vi.fn(),
  stopRetirement: vi.fn(),
  payloads: new Array<(payload: FsChangedPayload) => void>(),
  errors: new Array<(error: Error) => void>()
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  subscribeRuntimeFileChanges: runtime.subscribe
}))
vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (id: string, listener: () => void) => {
    runtime.contact.set(id, listener)
    return runtime.stopContact
  }
}))
vi.mock('@/runtime/runtime-environment-revision', () => ({
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
const change: FsChangedPayload = {
  worktreePath: '/repo',
  events: [{ kind: 'update', absolutePath: '/repo/README.md' }]
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
  it('routes the initial watch to its owner and leaves ordinary payloads unchanged', async () => {
    const onPayload = vi.fn()
    const stopStream = vi.fn()
    runtime.subscribe.mockResolvedValue(stopStream)
    const stop = subscribeEditorRuntimeFileWatch(target, onPayload, vi.fn())
    await settle()
    expect(runtime.subscribe).toHaveBeenCalledWith(
      {
        target: { kind: 'environment', environmentId: 'host-a' },
        worktreeId: 'wt',
        worktreePath: '/repo',
        connectionId: undefined
      },
      expect.any(Function),
      expect.any(Function)
    )
    expect(onPayload).not.toHaveBeenCalled()
    runtime.subscribe.mock.calls[0][1](change)
    expect(onPayload).toHaveBeenCalledWith(change)
    stop()
    stop()
    expect(stopStream).toHaveBeenCalledOnce()
    expect(runtime.stopContact).toHaveBeenCalledOnce()
    expect(runtime.stopRetirement).toHaveBeenCalledOnce()
  })

  it('retains a non-Git folder workspace and its host during recovery', async () => {
    runtime.subscribe.mockResolvedValue(vi.fn())
    const folder = { ...target, worktreeId: folderWorkspaceKey('notes'), worktreePath: '/notes' }
    const onPayload = vi.fn()
    const stop = subscribeEditorRuntimeFileWatch(folder, onPayload, vi.fn())
    await settle()
    runtime.contact.get('host-a')?.()
    await settle()
    expect(runtime.subscribe).toHaveBeenLastCalledWith(
      {
        target: { kind: 'environment', environmentId: 'host-a' },
        worktreeId: folder.worktreeId,
        worktreePath: '/notes',
        connectionId: undefined
      },
      expect.any(Function),
      expect.any(Function)
    )
    expect(onPayload).toHaveBeenCalledWith({
      worktreePath: '/notes',
      events: [{ kind: 'overflow', absolutePath: '/notes' }]
    })
    stop()
  })

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
    expect(onPayload).toHaveBeenCalledOnce()
    expect(onPayload).toHaveBeenCalledWith({
      worktreePath: '/repo',
      events: [{ kind: 'overflow', absolutePath: '/repo' }]
    })
    stop()
    expect(stopFresh).toHaveBeenCalledOnce()
  })

  it('drops payloads and errors from replaced attempts and unrelated host contact', async () => {
    const onPayload = vi.fn()
    const onError = vi.fn()
    runtime.subscribe.mockImplementation((_context, payload, error) => {
      runtime.payloads.push(payload)
      runtime.errors.push(error)
      return Promise.resolve(vi.fn())
    })
    const stop = subscribeEditorRuntimeFileWatch(target, onPayload, onError)
    await settle()
    runtime.contact.get('host-b')?.()
    expect(runtime.subscribe).toHaveBeenCalledOnce()
    runtime.contact.get('host-a')?.()
    await settle()
    onPayload.mockClear()
    runtime.payloads[0](change)
    runtime.errors[0](new Error('old transport'))
    expect(onPayload).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled()
    runtime.payloads[1](change)
    expect(onPayload).toHaveBeenCalledOnce()
    stop()
    runtime.payloads[1](change)
    runtime.contact.get('host-a')?.()
    expect(onPayload).toHaveBeenCalledOnce()
    expect(runtime.subscribe).toHaveBeenCalledTimes(2)
  })

  it('stops on owner retirement so a same-ID replacement cannot revive old work', async () => {
    const stopStream = vi.fn()
    runtime.subscribe.mockResolvedValue(stopStream)
    const stop = subscribeEditorRuntimeFileWatch(target, vi.fn(), vi.fn())
    await settle()
    for (const retire of runtime.retire) {
      retire(['host-b'])
    }
    expect(stopStream).not.toHaveBeenCalled()
    for (const retire of runtime.retire) {
      retire(['host-a'])
    }
    expect(stopStream).toHaveBeenCalledOnce()
    runtime.contact.get('host-a')?.()
    expect(runtime.subscribe).toHaveBeenCalledOnce()
    stop()
    expect(stopStream).toHaveBeenCalledOnce()
  })
})
