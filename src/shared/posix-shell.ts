import { spawnSync } from 'node:child_process'

/** Where a POSIX shell is, asked by running one.
 *
 *  Tests that exercise shell command generation hardcoded `/bin/sh`, which does
 *  not exist on Windows — so they failed there on the spawn rather than on the
 *  commands they meant to check. A Git installation does put a POSIX `sh` on
 *  PATH, and finding it lets those cases run for real instead of being skipped.
 *
 *  `ORCA_POSIX_SHELL` overrides the search, mirroring `ORCA_POWERSHELL_EXECUTABLE`. */

const CANDIDATES = ['/bin/sh', 'sh'] as const

let resolved: string | null | undefined
let canonical: boolean | undefined

function runs(candidate: string): boolean {
  return spawnSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0
}

/** The first POSIX shell that runs here, or null when there is none. */
export function findPosixShell(): string | null {
  if (resolved !== undefined) {
    return resolved
  }
  const configured = process.env.ORCA_POSIX_SHELL?.trim()
  const candidates = configured ? [configured, ...CANDIDATES] : CANDIDATES
  resolved = candidates.find((candidate) => runs(candidate)) ?? null
  return resolved
}

/** Whether `/bin/sh` itself resolves, by that exact name.
 *
 *  A separate question from `findPosixShell`: a suite that fakes
 *  `process.platform = 'linux'` sends production down paths that spawn
 *  `/bin/sh` literally, and Git's `sh` on PATH does nothing for those. */
export function hasPosixShellAtCanonicalPath(): boolean {
  canonical ??= runs('/bin/sh')
  return canonical
}
