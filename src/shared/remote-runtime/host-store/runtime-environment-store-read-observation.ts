import { AsyncLocalStorage } from 'node:async_hooks'

type Observation = { generation?: number; changed: boolean }
const observations = new AsyncLocalStorage<Observation>()

/** Records the generation actually read, including reads satisfied by a derived cache. */
export function recordEnvironmentStoreRead(generation: number): void {
  captureEnvironmentStoreRead()?.(generation)
}

export function captureEnvironmentStoreRead(): ((generation: number) => void) | undefined {
  const observation = observations.getStore()
  if (!observation) {
    return undefined
  }
  return (generation) => {
    observation.changed ||=
      observation.generation !== undefined && observation.generation !== generation
    observation.generation = generation
  }
}

/** Writes queued ahead of the first observation are already included, so cannot stale it. */
export async function observeEnvironmentStoreReads<T>(
  read: () => Promise<T>,
  currentGeneration: () => number
): Promise<{ value: T; generation: number; current: boolean }> {
  const observation: Observation = { changed: false }
  const value = await observations.run(observation, read)
  const generation = observation.generation ?? currentGeneration()
  return {
    value,
    generation,
    current: !observation.changed && generation === currentGeneration()
  }
}
