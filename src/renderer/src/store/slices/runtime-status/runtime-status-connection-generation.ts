const connectionGenerationByEnvironment = new Map<string, number>()

export function getRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  return connectionGenerationByEnvironment.get(environmentId) ?? 0
}

export function setRuntimeEnvironmentConnectionGenerationForTests(
  environmentId: string,
  generation: number
): void {
  connectionGenerationByEnvironment.set(environmentId, generation)
}

export function advanceRuntimeEnvironmentConnectionGeneration(environmentId: string): number {
  const next = getRuntimeEnvironmentConnectionGeneration(environmentId) + 1
  connectionGenerationByEnvironment.set(environmentId, next)
  return next
}

export function clearRuntimeEnvironmentConnectionGenerations(): Iterable<string> {
  const environmentIds = [...connectionGenerationByEnvironment.keys()]
  connectionGenerationByEnvironment.clear()
  return environmentIds
}
