import { ipcOrRuntimeTargetForHostId } from './runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'

/** How often a refused read is re-asked from a host whose running signal cannot reach us. */
export const REFUSED_WSL_READ_REPOLL_MS = 30_000

/**
 * Runs `read` and, while a stopped WSL distro refuses it (E9), re-asks once that distro runs: on
 * main's running signal for this app's repos, or for a paired host (whose signal never reaches
 * this window) on window focus and every 30 s while visible. Returns a cancel.
 */
export function watchRefusedWslRead<T>(args: {
  hostId: ExecutionHostId
  read: () => Promise<T>
  /** The distro that refused this result, or undefined when it answered. */
  refusedDistro: (result: T) => string | undefined
  onResult: (result: T) => void
  onError: (error: unknown) => void
}): () => void {
  let cancelled = false
  let inFlight = false
  let refused: string | null = null
  // Running signals that land while main is still answering would otherwise be missed.
  let ranDuringRead = new Set<string>()
  let repoll: ReturnType<typeof setInterval> | null = null
  const onDistroRunning = window.api?.preflight?.onWslDistroRunning
  const hearsHostSignal =
    ipcOrRuntimeTargetForHostId(args.hostId)?.kind === 'local' &&
    typeof onDistroRunning === 'function'

  const reaskFromPairedHost = (): void => {
    if (refused && !inFlight && document.visibilityState === 'visible') {
      load()
    }
  }
  const syncRepoll = (): void => {
    if (refused && !hearsHostSignal && !repoll) {
      repoll = setInterval(reaskFromPairedHost, REFUSED_WSL_READ_REPOLL_MS)
    } else if (!refused && repoll) {
      clearInterval(repoll)
      repoll = null
    }
  }
  function load(): void {
    inFlight = true
    ranDuringRead = new Set()
    args.read().then(
      (result) => {
        inFlight = false
        if (cancelled) {
          return
        }
        args.onResult(result)
        refused = args.refusedDistro(result)?.toLowerCase() ?? null
        syncRepoll()
        if (refused && ranDuringRead.has(refused)) {
          load()
        }
      },
      (error: unknown) => {
        inFlight = false
        if (!cancelled) {
          args.onError(error)
        }
      }
    )
  }

  // Subscribed before the first read, so no running signal can fall between answer and listener.
  const stopListening =
    hearsHostSignal && onDistroRunning
      ? onDistroRunning((distro) => {
          const key = distro.toLowerCase()
          if (inFlight) {
            ranDuringRead.add(key)
          } else if (key === refused) {
            load()
          }
        })
      : null
  if (!hearsHostSignal) {
    window.addEventListener('focus', reaskFromPairedHost)
  }
  load()
  return () => {
    cancelled = true
    stopListening?.()
    if (!hearsHostSignal) {
      window.removeEventListener('focus', reaskFromPairedHost)
    }
    if (repoll) {
      clearInterval(repoll)
    }
  }
}
