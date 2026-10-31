import { chmod, rm, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { escapeP4FileArg } from '../p4-command'
import type { P4Record } from '../p4-tagged-output'
import { WorkspaceCopyError } from './workspace-copy-errors'
import { relativeTo } from './workspace-copy-files'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import type { WorkspaceCopyNames } from './workspace-copy-names'
import {
  forceSync,
  haveDigests,
  haveRevisions,
  OPEN_FOR_NEW_FILE,
  unescapeP4Path,
  type ClientPathMap
} from './workspace-copy-p4'
import { isPathUnder, type CopySource } from './workspace-copy-source'

const NOTHING_TO_FETCH =
  /no such file\(s\)|file\(s\) not on client|file\(s\) not in client view|file\(s\) up-to-date/i

function localPath(copyRoot: string, rel: string): string {
  return join(copyRoot, ...rel.split('/'))
}

async function deleteLocalFile(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    return false
  }
  await chmod(path, 0o666)
  await rm(path, { force: true })
  return true
}

function haveSpec(client: string, rel: string): string {
  return `//${client}/${escapeP4FileArg(rel)}#have`
}

function clientRelative(record: P4Record, client: string): string | null {
  const prefix = `//${client}/`
  const clientFile = record.clientFile ?? ''
  return clientFile.toLowerCase().startsWith(prefix.toLowerCase())
    ? unescapeP4Path(clientFile.slice(prefix.length))
    : null
}

/**
 * Files the source has open arrive as unopened edits, untracked adds or missing deletes. They go back
 * to the depot state so the copy starts clean rather than from someone's half-finished change.
 */
export async function restoreOpenedFiles(
  host: WorkspaceCopyHost,
  source: CopySource,
  names: WorkspaceCopyNames,
  sourceOpened: readonly P4Record[],
  options: { removeAddsOnly: boolean }
): Promise<{ restoredToHave: number; removedAdds: number }> {
  const specs: string[] = []
  let removedAdds = 0
  for (const record of sourceOpened) {
    const rel = clientRelative(record, source.client)
    if (rel === null) {
      continue
    }
    if (OPEN_FOR_NEW_FILE.has(record.action ?? '')) {
      removedAdds += (await deleteLocalFile(localPath(names.copyRoot, rel))) ? 1 : 0
    } else if (!options.removeAddsOnly) {
      specs.push(haveSpec(names.client, rel))
    }
  }
  await forceSync(host, names.client, names.copyRoot, specs)
  return { restoredToHave: specs.length, removedAdds }
}

/** Tracked files under skipped folders come back from the depot at the have revision. */
export async function restoreTrackedInExcluded(
  host: WorkspaceCopyHost,
  source: CopySource,
  names: WorkspaceCopyNames,
  excluded: readonly string[]
): Promise<number> {
  const specs = excluded.map(
    (folder) => `//${names.client}/${escapeP4FileArg(relativeTo(source.root, folder))}/...#have`
  )
  const output = await forceSync(host, names.client, names.copyRoot, specs, NOTHING_TO_FETCH)
  return output
    .split(/\r?\n/)
    .filter((line) => / - (refreshing|added as|updating|replacing) /.test(line)).length
}

/**
 * The source can sync while robocopy runs, leaving old and new files under one have-list. Every file
 * whose have revision moved is put back to the copy's own have revision, or deleted when the copy
 * does not have it.
 */
export async function repairChangedDuringCopy(
  host: WorkspaceCopyHost,
  source: CopySource,
  names: WorkspaceCopyNames,
  before: ClientPathMap
): Promise<number> {
  const after = await haveRevisions(host, source.client, source.root)
  const changed = new Map<string, string>()
  for (const [key, entry] of before) {
    if (after.get(key)?.value !== entry.value) {
      changed.set(key, entry.rel)
    }
  }
  for (const [key, entry] of after) {
    if (!before.has(key)) {
      changed.set(key, entry.rel)
    }
  }
  if (changed.size === 0) {
    return 0
  }
  const copyHave = await haveRevisions(host, names.client, names.copyRoot)
  const specs: string[] = []
  for (const [key, rel] of changed) {
    if (copyHave.has(key)) {
      specs.push(haveSpec(names.client, rel))
    } else {
      await deleteLocalFile(localPath(names.copyRoot, rel))
    }
  }
  await forceSync(host, names.client, names.copyRoot, specs)
  return changed.size
}

/**
 * For a copy on another stream: after the flush to that stream's head, the server digests of the two
 * have-lists name the files whose content differs; only those are fetched, and files only the source
 * tracks are deleted. Hashing files on disk instead took 4.5 of 6 minutes on an ~80 GB workspace.
 */
export async function alignToStream(
  host: WorkspaceCopyHost,
  source: CopySource,
  names: WorkspaceCopyNames,
  sourceOpened: readonly P4Record[]
): Promise<{ fetched: number; removedStale: number }> {
  const copy = await haveDigests(host, names.client, names.copyRoot)
  const original = await haveDigests(host, source.client, source.root)
  let removedStale = 0
  for (const [key, entry] of original) {
    if (!copy.has(key) && (await deleteLocalFile(localPath(names.copyRoot, entry.rel)))) {
      removedStale += 1
    }
  }
  const fetch = new Map<string, string>()
  for (const [key, entry] of copy) {
    if (!entry.value || original.get(key)?.value !== entry.value) {
      fetch.set(key, entry.rel)
    }
  }
  // Digests compare depot revisions, so a file open for edit in the source looks identical while
  // its working copy holds the unsubmitted change.
  for (const record of sourceOpened) {
    const rel = OPEN_FOR_NEW_FILE.has(record.action ?? '')
      ? null
      : clientRelative(record, source.client)
    if (rel !== null && copy.has(rel.toLowerCase())) {
      fetch.set(rel.toLowerCase(), rel)
    }
  }
  // Files the source deleted locally without opening them are missing here too.
  const missing = await host.p4(['-c', names.client, 'diff', '-sd', `//${names.client}/...`], {
    cwd: names.copyRoot
  })
  const unexpected = missing.stderr
    .split(/\r?\n/)
    .filter(
      (line) => line.trim() && !/no such file|not on client|up-to-date|no file\(s\) to/i.test(line)
    )
  if (unexpected.length > 0) {
    throw new WorkspaceCopyError(
      'perforce',
      `p4 diff -sd in the copy failed: ${unexpected.join(' ')}`
    )
  }
  for (const line of missing.stdout.split(/\r?\n/)) {
    const path = line.trim()
    if (/^[A-Za-z]:\\/.test(path) && isPathUnder(path, names.copyRoot) && path !== names.copyRoot) {
      const rel = path
        .slice(names.copyRoot.length + 1)
        .split(sep)
        .join('/')
      fetch.set(rel.toLowerCase(), rel)
    }
  }
  await forceSync(
    host,
    names.client,
    names.copyRoot,
    [...fetch.values()].map((rel) => haveSpec(names.client, rel))
  )
  return { fetched: fetch.size, removedStale }
}
