let writes = 0

/** Every persisted input can change the merged registry, including a partial compound save. */
export function noteEnvironmentStoreWrite(): void {
  writes++
}

export function environmentStoreWriteCount(): number {
  return writes
}
