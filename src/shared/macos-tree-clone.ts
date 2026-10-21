import { rm as nodeRm } from 'node:fs/promises'
import { runProcess } from '@orca/process-host'

export type MacTreeCloneOptions = {
  signal?: AbortSignal
  /** Electron main passes its asar-transparent `rm`; plain Node's is the default. */
  rm?: typeof nodeRm
}

/**
 * Copies `source` to `destination`, whose parent must exist, keeping symlinks as links. One
 * `/bin/cp` per tree is several times faster than Node's file-by-file `fs.cp` on APFS.
 * Resolves false when neither a clone nor a plain copy succeeds.
 */
export async function cloneMacTree(
  source: string,
  destination: string,
  options: MacTreeCloneOptions = {}
): Promise<boolean> {
  const rm = options.rm ?? nodeRm
  // APFS clone first; a failed clone can leave a partial tree on other filesystems.
  // Clearing also keeps `cp -R` from nesting `source` inside an existing `destination`.
  for (const args of [['-cR'], ['-R']]) {
    await rm(destination, { recursive: true, force: true })
    const result = await runProcess({
      program: '/bin/cp',
      args: [...args, source, destination],
      maxOutputBytes: 8192,
      signal: options.signal
    })
    if (result.code === 0 && !result.timedOut) {
      return true
    }
  }
  return false
}
