type LocalPtySpawnShell = { shell: string; incarnationId: string | undefined }

// Why: a PTY keeps the shell main chose when it started; the default setting only affects later spawns.
const spawnShellByPtyId = new Map<string, LocalPtySpawnShell>()

/** Record (or forget) the shell main selected for a fresh local spawn of `ptyId`. */
export function recordLocalPtySpawnShell(
  ptyId: string,
  incarnationId: string | undefined,
  shell: string | undefined
): void {
  if (shell) {
    spawnShellByPtyId.set(ptyId, { shell, incarnationId })
  } else {
    spawnShellByPtyId.delete(ptyId)
  }
}

/** Keep the recorded shell only when a reattach provably names the same process. */
export function retainLocalPtySpawnShellOnReattach(
  ptyId: string,
  incarnationId: string | undefined
): void {
  const recorded = spawnShellByPtyId.get(ptyId)
  if (recorded && (!incarnationId || recorded.incarnationId !== incarnationId)) {
    spawnShellByPtyId.delete(ptyId)
  }
}

export function forgetLocalPtySpawnShell(ptyId: string): void {
  spawnShellByPtyId.delete(ptyId)
}

/** The shell this renderer saw main start for `ptyId`; undefined when it never saw the spawn. */
export function readLocalPtySpawnShell(ptyId: string): string | undefined {
  return spawnShellByPtyId.get(ptyId)?.shell
}
