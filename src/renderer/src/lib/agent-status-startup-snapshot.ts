export type AgentStatusStartupSnapshotLoader = () => Promise<void>

type PendingStartupSnapshotRequest = {
  resolve: () => void
  reject: (reason: unknown) => void
}

const STARTUP_SNAPSHOT_REQUEST_TIMEOUT_MS = 5000

let activeLoader: AgentStatusStartupSnapshotLoader | null = null
let pendingRequests: PendingStartupSnapshotRequest[] = []

/**
 * Register the renderer-side startup snapshot loader. The loader is installed
 * by the always-mounted IPC bridge and consumed by App before terminal panes
 * are allowed to cold-restore.
 */
export function registerAgentStatusStartupSnapshotLoader(
  loader: AgentStatusStartupSnapshotLoader
): () => void {
  activeLoader = loader

  const requests = pendingRequests
  pendingRequests = []
  for (const request of requests) {
    void Promise.resolve()
      .then(() => loader())
      .then(request.resolve, request.reject)
  }

  let disposed = false
  return () => {
    if (disposed) {
      return
    }
    disposed = true
    if (activeLoader === loader) {
      activeLoader = null
    }
  }
}

export function requestAgentStatusStartupSnapshot(): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    const complete = (): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      resolve()
    }
    const fail = (reason: unknown): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timeout)
      reject(reason)
    }
    const request: PendingStartupSnapshotRequest = { resolve: complete, reject: fail }

    // The snapshot is fail-open on every path: startup must never wait forever
    // on a missing loader or a hung snapshot IPC. The normal post-ready retry
    // remains responsible for applying a late snapshot.
    timeout = setTimeout(() => {
      const index = pendingRequests.indexOf(request)
      if (index >= 0) {
        pendingRequests.splice(index, 1)
      }
      complete()
    }, STARTUP_SNAPSHOT_REQUEST_TIMEOUT_MS)

    const loader = activeLoader
    if (loader) {
      try {
        void Promise.resolve(loader()).then(complete, fail)
      } catch (error) {
        fail(error)
      }
      return
    }
    pendingRequests.push(request)
  })
}
