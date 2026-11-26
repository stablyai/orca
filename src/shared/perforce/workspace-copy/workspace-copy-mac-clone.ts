import { lstat, mkdir, readdir, stat, utimes } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { runProcess } from '@orca/process-host'
import type { TreeCopyResult, TreeExclusions } from './workspace-copy-types'

// Why the full path: a GNU cp earlier on PATH reads -c as --preserve=context, not clonefile.
const MAC_CP = '/bin/cp'
const PARALLEL_CP = 6
const MAX_SOURCES_PER_CP = 400
const CP_TIMEOUT_MS = 2 * 60 * 60 * 1000
const CP_OUTPUT_BYTES = 1024 * 1024

export type MacClonePlan = {
  /** Folders walked here (each made in the destination), parents before their children. */
  folders: [string, string][]
  /** Entries handed to cp whole, grouped by the destination folder they go into. */
  batches: { sources: string[]; into: string }[]
}

function key(path: string): string {
  // Why lower case: copies are only made on case-insensitive volumes.
  return resolve(path).toLowerCase()
}

/** Folders strictly between `root` and an excluded path: listed here, never handed to cp whole. */
function foldersAboveExclusions(root: string, excluded: readonly string[]): Set<string> {
  const above = new Set<string>()
  const inside = `${key(root)}${sep}`
  for (const path of excluded) {
    for (
      let dir = key(dirname(path));
      dir.startsWith(inside) && !above.has(dir);
      dir = dirname(dir)
    ) {
      above.add(dir)
    }
  }
  return above
}

/**
 * Walks only the folders that contain an excluded path and hands every other entry to cp whole, so
 * a Unity project costs a few folder listings instead of one call per file.
 */
export async function planMacClone(
  source: string,
  destination: string,
  exclusions: TreeExclusions
): Promise<MacClonePlan> {
  const excluded = [...exclusions.folders, ...exclusions.files]
  const skip = new Set(excluded.map(key))
  const walk = foldersAboveExclusions(source, excluded)
  const plan: MacClonePlan = { folders: [], batches: [] }
  const pending: [string, string][] = [[source, destination]]
  for (let next = pending.shift(); next; next = pending.shift()) {
    const [from, to] = next
    // Why: readdir follows a link, so a folder swapped for one after its listing would pull in an outside tree.
    if (from !== source && !(await lstat(from)).isDirectory()) {
      throw new Error(`${from} stopped being a folder while the copy was planned`)
    }
    await mkdir(to, { recursive: true })
    plan.folders.push(next)
    const sources: string[] = []
    for (const entry of await readdir(from, { withFileTypes: true })) {
      const path = join(from, entry.name)
      if (skip.has(key(path))) {
        continue
      }
      if (entry.isDirectory() && walk.has(key(path))) {
        pending.push([path, join(to, entry.name)])
      } else {
        sources.push(path)
      }
    }
    for (let i = 0; i < sources.length; i += MAX_SOURCES_PER_CP) {
      plan.batches.push({ sources: sources.slice(i, i + MAX_SOURCES_PER_CP), into: to })
    }
  }
  return plan
}

/**
 * Clones a workspace with macOS's own cp: -c clones each file with clonefile (which keeps its
 * times, so content and modification time are always one version), -R copies symbolic links as
 * links, -p keeps folder times. cp falls back to a full copy where a clone is impossible, so callers
 * measure free space rather than trust the exit code.
 */
export async function macCloneTree(
  source: string,
  destination: string,
  exclusions: TreeExclusions
): Promise<TreeCopyResult> {
  const plan = await planMacClone(source, destination, exclusions)
  const failures: string[] = []
  let index = 0
  const worker = async (): Promise<void> => {
    while (index < plan.batches.length) {
      const { sources, into } = plan.batches[index++]
      const result = await runProcess({
        program: MAC_CP,
        args: ['-cpR', '--', ...sources, into],
        timeoutMs: CP_TIMEOUT_MS,
        maxOutputBytes: CP_OUTPUT_BYTES
      })
      if (result.timedOut) {
        failures.push(`cp timed out copying into ${into}`)
      } else if (result.code !== 0) {
        const lines = result.stderr.split('\n').filter(Boolean)
        failures.push(
          ...(lines.length > 0 ? lines : [`cp exited ${result.code} copying into ${into}`])
        )
      }
    }
  }
  await Promise.all(Array.from({ length: PARALLEL_CP }, worker))
  if (failures.length > 0) {
    return {
      ok: false,
      message: `${failures.length} file(s) could not be copied: ${failures.slice(0, 3).join('; ')}`
    }
  }
  // Writing into a folder moves its time, so the walked folders get theirs last, deepest first.
  for (const [from, to] of plan.folders.toReversed()) {
    const original = await stat(from)
    await utimes(to, original.atime, original.mtime)
  }
  return { ok: true, files: null, bytes: null, cloned: null }
}
