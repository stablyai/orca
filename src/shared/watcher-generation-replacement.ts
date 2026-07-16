type WatcherGenerationOwner = {
  closed: boolean
  generation: number
}

type WatcherGenerationReplacement = {
  generation: number
  promise: Promise<void>
}

export function startWatcherGenerationReplacement(
  owner: WatcherGenerationOwner,
  failedGeneration: number,
  onClaim: () => (() => Promise<void>) | undefined,
  install: (generation: number) => Promise<void>
): WatcherGenerationReplacement | null {
  if (owner.closed || owner.generation !== failedGeneration) {
    return null
  }
  // Why: generation ownership must change before any teardown promise can
  // yield, or duplicate native callbacks can start competing replacements.
  const generation = ++owner.generation
  const promise = (async () => {
    const release = onClaim()
    if (release) {
      await release()
    }
    if (owner.closed || owner.generation !== generation) {
      return
    }
    await install(generation)
  })()
  return { generation, promise }
}
