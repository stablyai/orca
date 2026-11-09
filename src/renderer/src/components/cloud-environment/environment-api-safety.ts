import type {
  EnvironmentBuildView,
  EnvironmentResult,
  EnvironmentsApi
} from './cloud-environment-types'

/** A rejected IPC promise becomes an ordinary error result, so no spinner can stay stuck. */
function settle<T>(promise: Promise<EnvironmentResult<T>>): Promise<EnvironmentResult<T>> {
  return promise.catch((cause: unknown): EnvironmentResult<T> => ({
    ok: false,
    error: {
      code: 'unavailable',
      message: cause instanceof Error ? cause.message : String(cause)
    }
  }))
}

/** The calls the settings panel makes, each guaranteed to resolve. */
type SettledCalls = Pick<
  EnvironmentsApi,
  'list' | 'get' | 'create' | 'update' | 'startBuild' | 'cancelBuild' | 'activateBuild'
>

export function settledEnvironmentsApi(api: SettledCalls): SettledCalls {
  return {
    list: () => settle(api.list()),
    get: (envId) => settle(api.get(envId)),
    create: (input) => settle(api.create(input)),
    update: (envId, patch) => settle(api.update(envId, patch)),
    startBuild: (envId) => settle(api.startBuild(envId)),
    cancelBuild: (envId, buildId) => settle(api.cancelBuild(envId, buildId)),
    activateBuild: (envId, buildId) => settle(api.activateBuild(envId, buildId))
  }
}

const STATUS_PROGRESS: Record<EnvironmentBuildView['status'], number> = {
  starting: 0,
  running: 1,
  snapshotting: 2,
  succeeded: 3,
  failed: 3,
  canceled: 3
}

function progressOf(build: EnvironmentBuildView): [number, number] {
  return [
    STATUS_PROGRESS[build.status],
    build.finishedAt ?? build.snapshotStartedAt ?? build.startedAt ?? build.createdAt
  ]
}

/**
 * Merge a fetched build list into what we have, keeping whichever view of each build is further
 * along: a poll that left before the live stream's last update must not roll a build back to
 * "running". `active` always comes from the fetch (activation doesn't advance a build).
 */
export function mergeBuildsByRecency(
  current: readonly EnvironmentBuildView[],
  fetched: readonly EnvironmentBuildView[]
): EnvironmentBuildView[] {
  const known = new Map(current.map((build) => [build.id, build]))
  return fetched.map((incoming) => {
    const existing = known.get(incoming.id)
    if (!existing) {
      return incoming
    }
    const [a, at] = progressOf(existing)
    const [b, bt] = progressOf(incoming)
    const keepExisting = a > b || (a === b && at > bt)
    return keepExisting ? { ...existing, active: incoming.active } : incoming
  })
}
