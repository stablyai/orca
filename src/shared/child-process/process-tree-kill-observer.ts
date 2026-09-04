/**
 * Seam that lets the main process record the tree-kills issued from here.
 *
 * Why a seam and not a direct call: `signalProcessTree` is the choke point every
 * `runProcess` termination funnels through, but it lives in `src/shared` and so
 * runs in the CLI and relay too — it cannot import the main-process crash
 * breadcrumb store. Main registers the recorder at startup; everywhere else this
 * stays a no-op.
 */

/** Blast radius, not mechanism: `win-taskkill-tree` is addressed by pid and walks
 *  whatever tree that pid has *now*, so it can land on a recycled pid that is
 *  since one of Orca's own Chromium processes. A process group can only contain
 *  processes Orca itself put there. */
export type ProcessTreeKillScope = 'win-taskkill-tree' | 'posix-process-group'

export type ProcessTreeKill = {
  pid: number
  site: string
  scope: ProcessTreeKillScope
}

type ProcessTreeKillObserver = (kill: ProcessTreeKill) => void

let observer: ProcessTreeKillObserver | null = null

export function setProcessTreeKillObserver(next: ProcessTreeKillObserver | null): void {
  observer = next
}

export function notifyProcessTreeKill(kill: ProcessTreeKill): void {
  try {
    observer?.(kill)
  } catch {
    // Diagnostics must never turn a successful termination into a failed one.
  }
}
