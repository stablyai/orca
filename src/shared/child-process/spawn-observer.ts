/**
 * Diagnostic seam for counting every child process started through this
 * package. `src/main/diagnostics/main-thread-churn-probe` registers itself here
 * under ORCA_MAIN_THREAD_DIAGNOSTICS=1; with nothing registered every spawn
 * pays one undefined check, so production behaviour is unchanged.
 *
 * Why a seam rather than a direct import: run-process.ts also runs in the
 * terminal daemon, the relay and the CLI, none of which may depend on main.
 */
export type SpawnObserver = (command: string, args: readonly string[], blockMs: number) => void

let observer: SpawnObserver | null = null

export function setSpawnObserver(next: SpawnObserver | null): void {
  observer = next
}

export function notifySpawnObserver(
  command: string,
  args: readonly string[],
  blockMs: number
): void {
  observer?.(command, args, blockMs)
}

export function hasSpawnObserver(): boolean {
  return observer !== null
}
