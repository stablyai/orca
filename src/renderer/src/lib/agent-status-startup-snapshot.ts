export type AgentStatusStartupSnapshotLoader = () => Promise<void>

const STARTUP_SNAPSHOT_REQUEST_TIMEOUT_MS = 5000

let activeLoader: AgentStatusStartupSnapshotLoader | null = null
let loaderWaiters: ((loader: AgentStatusStartupSnapshotLoader) => void)[] = []

/**
 * Register the renderer-side startup snapshot loader. The loader is installed
 * by the always-mounted IPC bridge and consumed by App before terminal panes
 * are allowed to cold-restore.
 */
export function registerAgentStatusStartupSnapshotLoader(
  loader: AgentStatusStartupSnapshotLoader
): () => void {
  activeLoader = loader

  const waiters = loaderWaiters
  loaderWaiters = []
  for (const notify of waiters) {
    notify(loader)
  }

  return () => {
    if (activeLoader === loader) {
      activeLoader = null
    }
  }
}

async function runSnapshotLoaderWhenRegistered(): Promise<void> {
  const loader =
    activeLoader ??
    (await new Promise<AgentStatusStartupSnapshotLoader>((resolve) => loaderWaiters.push(resolve)))
  await loader()
}

export async function requestAgentStatusStartupSnapshot(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  // The snapshot is fail-open on every path: startup must never wait forever
  // on a missing loader or a hung snapshot IPC. The normal post-ready retry
  // remains responsible for applying a late snapshot.
  const timedOut = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, STARTUP_SNAPSHOT_REQUEST_TIMEOUT_MS)
  })
  try {
    await Promise.race([runSnapshotLoaderWhenRegistered(), timedOut])
  } finally {
    clearTimeout(timer)
  }
}
