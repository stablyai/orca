export type SnapshotAvailability = 'ready' | 'missing' | 'denied' | 'unavailable'

export type MemorySnapshot<T> = {
  value: T | null
  stale: boolean
  age: number | null
  availability: SnapshotAvailability
}
