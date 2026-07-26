export const REPO_SLUG_RESOLUTION_CONCURRENCY = 8
export const MAX_REPO_SLUG_RESOLUTION_WAITERS = 64

let activeResolutions = 0
const slotWaiters = new Set<() => void>()
const CANCELLED_RESOLUTION = Symbol('cancelled repo slug resolution')
const REJECTED_RESOLUTION = Symbol('rejected repo slug resolution')

type SlotAdmission = 'acquired' | 'cancelled' | 'rejected'

function acquireResolutionSlot(signal?: AbortSignal): Promise<SlotAdmission> {
  if (signal?.aborted) {
    return Promise.resolve('cancelled')
  }
  if (activeResolutions < REPO_SLUG_RESOLUTION_CONCURRENCY) {
    activeResolutions += 1
    return Promise.resolve('acquired')
  }
  if (slotWaiters.size >= MAX_REPO_SLUG_RESOLUTION_WAITERS) {
    return Promise.resolve('rejected')
  }
  return new Promise((resolve) => {
    const resume = (): void => {
      signal?.removeEventListener('abort', cancel)
      resolve('acquired')
    }
    const cancel = (): void => {
      if (slotWaiters.delete(resume)) {
        resolve('cancelled')
      }
    }
    slotWaiters.add(resume)
    signal?.addEventListener('abort', cancel, { once: true })
  })
}

function releaseResolutionSlot(): void {
  activeResolutions -= 1
  const next = slotWaiters.values().next().value
  if (next) {
    slotWaiters.delete(next)
    activeResolutions += 1
    next()
  }
}

async function resolveWithSharedSlot<T>(
  resolver: () => Promise<T>,
  onFailure: () => void,
  signal?: AbortSignal
): Promise<T | typeof CANCELLED_RESOLUTION | typeof REJECTED_RESOLUTION> {
  const admission = await acquireResolutionSlot(signal)
  if (admission === 'cancelled') {
    return CANCELLED_RESOLUTION
  }
  if (admission === 'rejected') {
    return REJECTED_RESOLUTION
  }
  if (signal?.aborted) {
    releaseResolutionSlot()
    return CANCELLED_RESOLUTION
  }
  try {
    return await resolver()
  } catch (error) {
    onFailure()
    throw error
  } finally {
    releaseResolutionSlot()
  }
}

export async function resolveRepoSlugsWithFixedWorkers<T>(
  repos: readonly T[],
  resolver: (repo: T) => Promise<string | null>,
  signal?: AbortSignal
): Promise<(string | null)[]> {
  const results = Array<string | null>(repos.length)
  let nextIndex = 0
  const buildController = new AbortController()
  const cancelBuild = (): void => buildController.abort()
  if (signal?.aborted) {
    buildController.abort()
  } else {
    signal?.addEventListener('abort', cancelBuild, { once: true })
  }
  const worker = async (): Promise<void> => {
    while (nextIndex < repos.length && !buildController.signal.aborted) {
      const index = nextIndex
      nextIndex += 1
      const slug = await resolveWithSharedSlot(
        () => resolver(repos[index]),
        () => buildController.abort(),
        buildController.signal
      )
      if (slug === CANCELLED_RESOLUTION) {
        return
      }
      if (slug === REJECTED_RESOLUTION) {
        buildController.abort()
        throw new Error('Too many queued repo slug resolutions.')
      }
      results[index] = slug
    }
  }
  const workerCount = Math.min(REPO_SLUG_RESOLUTION_CONCURRENCY, repos.length)
  try {
    await Promise.all(Array.from({ length: workerCount }, worker))
    if (signal?.aborted) {
      throw new Error('Repo slug index resolution was cancelled.')
    }
    return results
  } catch (error) {
    buildController.abort()
    throw error
  } finally {
    signal?.removeEventListener('abort', cancelBuild)
  }
}

export function getRepoSlugResolutionPoolStateForTests(): {
  active: number
  waiters: number
} {
  return { active: activeResolutions, waiters: slotWaiters.size }
}
