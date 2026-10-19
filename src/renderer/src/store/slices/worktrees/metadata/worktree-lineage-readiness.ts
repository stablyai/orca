import type { AppState } from '../../../types'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import { getRuntimeEnvironmentRevision } from '../../../../runtime/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '../../runtime-status-connection-generation'

type LineageStoreReader = () => Pick<AppState, 'worktreeLineageById' | 'workspaceLineageByChildKey'>
type LineageReadiness = {
  revision: number | undefined
  connectionGeneration: number
  generation: number
  pending: number
  hydrated: boolean
}

const readinessByStore = new WeakMap<LineageStoreReader, Map<string, LineageReadiness>>()
const MAX_READINESS_ENVIRONMENTS = 256

function getReadiness(getState: LineageStoreReader, environmentId: string): LineageReadiness {
  const byEnvironment = readinessByStore.get(getState) ?? new Map<string, LineageReadiness>()
  readinessByStore.set(getState, byEnvironment)
  const revision = getRuntimeEnvironmentRevision(environmentId)
  const connectionGeneration = getRuntimeEnvironmentConnectionGeneration(environmentId)
  let readiness = byEnvironment.get(environmentId)
  if (
    !readiness ||
    readiness.revision !== revision ||
    readiness.connectionGeneration !== connectionGeneration
  ) {
    readiness = { revision, connectionGeneration, generation: 0, pending: 0, hydrated: false }
    if (!byEnvironment.has(environmentId) && byEnvironment.size >= MAX_READINESS_ENVIRONMENTS) {
      const oldest = byEnvironment.keys().next().value
      if (oldest !== undefined) {
        byEnvironment.delete(oldest)
      }
    }
    byEnvironment.set(environmentId, readiness)
  }
  return readiness
}

export function invalidateRemoteWorktreeLineage(
  getState: LineageStoreReader,
  environmentId: string
): void {
  const readiness = getReadiness(getState, environmentId)
  readiness.generation += 1
  readiness.hydrated = false
}

export function isRemoteWorktreeLineageFresh(
  getState: LineageStoreReader,
  environmentId: string
): boolean {
  const readiness = getReadiness(getState, environmentId)
  return readiness.hydrated && readiness.pending === 0
}

export function beginWorktreeLineageRefresh(
  getState: LineageStoreReader,
  target: RuntimeClientTarget
): (succeeded: boolean) => void {
  if (target.kind !== 'environment') {
    return () => {}
  }
  const readiness = getReadiness(getState, target.environmentId)
  const generation = ++readiness.generation
  readiness.pending += 1
  readiness.hydrated = false
  return (succeeded) => {
    readiness.pending -= 1
    if (!succeeded || generation === readiness.generation) {
      readiness.hydrated = succeeded
    }
  }
}
