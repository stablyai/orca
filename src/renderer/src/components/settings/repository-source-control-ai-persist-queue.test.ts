import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RepoSourceControlAiOverrides } from '../../../../shared/source-control-ai-types'
import { createRepoAiPersistQueue } from './repository-source-control-ai-persist-queue'

type Harness = ReturnType<typeof makeQueue>

function makeQueue(opts: { isMounted?: () => boolean; getRepoId?: () => string } = {}) {
  let persisted: RepoSourceControlAiOverrides = {}
  let repoId = 'repo-1'
  const updateRepo = vi.fn()
  const onError = vi.fn()
  const setPersisted = vi.fn((value: RepoSourceControlAiOverrides) => {
    persisted = value
  })
  const queue = createRepoAiPersistQueue({
    getRepoId: opts.getRepoId ?? (() => repoId),
    getPersisted: () => persisted,
    setPersisted,
    updateRepo,
    isMounted: opts.isMounted ?? (() => true),
    onError
  })
  return {
    queue,
    updateRepo,
    onError,
    setPersisted,
    getPersisted: () => persisted,
    setRepoId: (next: string) => {
      repoId = next
    }
  }
}

describe('createRepoAiPersistQueue', () => {
  let h: Harness
  beforeEach(() => {
    h = makeQueue()
  })

  it('persists a changed value and stores the normalized saved result', async () => {
    h.updateRepo.mockResolvedValue(true)
    const ok = await h.queue.persistTransform((base) => ({ ...base, enabled: true }))
    expect(ok).toBe(true)
    expect(h.updateRepo).toHaveBeenCalledTimes(1)
    expect(h.getPersisted()).toMatchObject({ enabled: true })
  })

  it('skips the backend write when the transform is a no-op', async () => {
    h.updateRepo.mockResolvedValue(true)
    const ok = await h.queue.persistTransform((base) => base)
    expect(ok).toBe(true)
    expect(h.updateRepo).not.toHaveBeenCalled()
  })

  it('serializes queued writes so each composes off the previous saved result', async () => {
    h.updateRepo.mockResolvedValue(true)
    const p1 = h.queue.persistTransform((base) => ({ ...base, enabled: true }))
    const p2 = h.queue.persistTransform((base) => ({ ...base, customAgentCommand: 'run {prompt}' }))
    await Promise.all([p1, p2])
    expect(h.updateRepo).toHaveBeenCalledTimes(2)
    // The second write must carry the first write's field -> it ran against the persisted result, not stale base.
    expect(h.getPersisted()).toMatchObject({ enabled: true, customAgentCommand: 'run {prompt}' })
  })

  it('returns false and reports an error when updateRepo returns false, leaving persisted untouched', async () => {
    h.updateRepo.mockResolvedValue(false)
    const ok = await h.queue.persistTransform((base) => ({ ...base, enabled: true }))
    expect(ok).toBe(false)
    expect(h.onError).toHaveBeenCalledWith('Failed to save Source Control AI settings.')
    expect(h.setPersisted).not.toHaveBeenCalled()
    expect(h.getPersisted()).toEqual({})
  })

  it('returns false and reports an error when updateRepo throws', async () => {
    h.updateRepo.mockRejectedValue(new Error('ipc down'))
    const ok = await h.queue.persistTransform((base) => ({ ...base, enabled: true }))
    expect(ok).toBe(false)
    expect(h.onError).toHaveBeenCalledWith('Failed to save Source Control AI settings.')
    expect(h.setPersisted).not.toHaveBeenCalled()
  })

  it('does not write persisted or report an error after unmount', async () => {
    const unmounted = makeQueue({ isMounted: () => false })
    unmounted.updateRepo.mockResolvedValue(true)
    const ok = await unmounted.queue.persistTransform((base) => ({ ...base, enabled: true }))
    expect(ok).toBe(true)
    expect(unmounted.setPersisted).not.toHaveBeenCalled()
    expect(unmounted.onError).not.toHaveBeenCalled()
  })

  it('lets a failed write not block the next queued write', async () => {
    h.updateRepo.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    const p1 = h.queue.persistTransform((base) => ({ ...base, enabled: true }))
    const p2 = h.queue.persistTransform((base) => ({ ...base, enabled: false }))
    const [ok1, ok2] = await Promise.all([p1, p2])
    expect(ok1).toBe(false)
    expect(ok2).toBe(true)
    expect(h.updateRepo).toHaveBeenCalledTimes(2)
    expect(h.getPersisted()).toMatchObject({ enabled: false })
  })

  it('abandons a queued write when the selected repo changes before it runs', async () => {
    let releaseFirst: () => void = () => {}
    h.updateRepo.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          releaseFirst = () => resolve(true)
        })
    )
    const p1 = h.queue.persistTransform((base) => ({ ...base, enabled: true }))
    // Let the first write enter updateRepo before queuing the second / switching repos.
    await Promise.resolve()
    await Promise.resolve()
    expect(h.updateRepo).toHaveBeenCalledTimes(1)
    expect(h.updateRepo.mock.calls[0]?.[0]).toBe('repo-1')

    const p2 = h.queue.persistTransform((base) => ({
      ...base,
      customAgentCommand: 'should-not-write'
    }))
    // Switch repos while the first write is in flight and the second is queued.
    h.setRepoId('repo-2')
    releaseFirst()
    const [ok1, ok2] = await Promise.all([p1, p2])
    expect(ok1).toBe(true)
    expect(ok2).toBe(true)
    // Second must not run against repo-2.
    expect(h.updateRepo).toHaveBeenCalledTimes(1)
    // Completing a stale write must not seed the new repo's local persisted base.
    expect(h.setPersisted).not.toHaveBeenCalled()
  })

  it('does not apply setPersisted when the repo switches during an in-flight updateRepo', async () => {
    let release: (ok: boolean) => void = () => {}
    h.updateRepo.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        })
    )
    const pending = h.queue.persistTransform((base) => ({ ...base, enabled: true }))
    h.setRepoId('repo-2')
    release(true)
    await expect(pending).resolves.toBe(true)
    expect(h.setPersisted).not.toHaveBeenCalled()
    expect(h.onError).not.toHaveBeenCalled()
  })
})
