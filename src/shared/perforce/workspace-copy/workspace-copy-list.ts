import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { P4Record } from '../p4-tagged-output'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import { markerMode, markerString, readMarker } from './workspace-copy-marker'
import { COPY_NAME_PATTERN } from './workspace-copy-name-rules'
import {
  copiesDirFor,
  copyClientPrefix,
  copyNameFromMarkerFile,
  copyNamesFor
} from './workspace-copy-names'
import { listClientsWithPrefix } from './workspace-copy-p4'
import { REMOVING_PREFIX } from './workspace-copy-remove'
import { normalizePath, pathExists, resolveCopySource } from './workspace-copy-source'
import type { WorkspaceCopyListEntry, WorkspaceCopyListResult } from './workspace-copy-types'

const sweeping = new Set<string>()

/** Folders a removal moved aside but could not finish deleting (the app quit, a file was held). */
function sweepLeftovers(host: WorkspaceCopyHost, copiesDir: string, entries: string[]): void {
  for (const entry of entries.filter((e) => e.startsWith(REMOVING_PREFIX))) {
    const path = join(copiesDir, entry)
    if (sweeping.has(path)) {
      continue
    }
    sweeping.add(path)
    void host
      .removeTree(path)
      .catch(() => {})
      .finally(() => sweeping.delete(path))
  }
}

/**
 * Copies of the workspace at `dir`: the markers and folders beside it, joined with the server's
 * `<client>_wt_*` clients. A copy a script made in the same layout shows up the same way.
 */
export async function listWorkspaceCopies(
  host: WorkspaceCopyHost,
  dir: string,
  options: { checkServer?: boolean } = {}
): Promise<WorkspaceCopyListResult> {
  const source = await resolveCopySource(host, dir)
  const copiesDir = copiesDirFor(source.root)
  const dirEntries = await readdir(copiesDir).catch((): string[] => [])
  sweepLeftovers(host, copiesDir, dirEntries)
  const names = new Map<string, string>()
  for (const entry of dirEntries) {
    const name = copyNameFromMarkerFile(entry) ?? (COPY_NAME_PATTERN.test(entry) ? entry : null)
    if (name) {
      names.set(name.toLowerCase(), name)
    }
  }
  const clients = new Map<string, P4Record>()
  let serverChecked = false
  let serverError: string | undefined
  if (options.checkServer !== false) {
    try {
      const prefix = copyClientPrefix(source.client)
      for (const record of await listClientsWithPrefix(host, prefix, source.root)) {
        const name = record.client.slice(prefix.length)
        if (COPY_NAME_PATTERN.test(name)) {
          clients.set(name.toLowerCase(), record)
          names.set(name.toLowerCase(), names.get(name.toLowerCase()) ?? name)
        }
      }
      serverChecked = true
    } catch (error) {
      serverError = error instanceof Error ? error.message : String(error)
    }
  }
  const copies: WorkspaceCopyListEntry[] = []
  for (const [key, name] of names) {
    const expected = copyNamesFor(source, name)
    const marker = await readMarker(expected.markerPath)
    const record = clients.get(key)
    const copyRoot = record?.Root ? normalizePath(record.Root) : expected.copyRoot
    copies.push({
      name,
      client: expected.client,
      copyRoot,
      stream: record?.Stream || markerString(marker, 'stream'),
      mode: markerMode(marker),
      folderExists: await pathExists(copyRoot),
      clientExists: record !== undefined,
      markerExists: marker !== null,
      created: markerString(marker, 'created'),
      createdBy: markerString(marker, 'createdBy')
    })
  }
  copies.sort((a, b) => a.name.localeCompare(b.name))
  return {
    source: { client: source.client, root: source.root, stream: source.stream },
    copiesDir,
    copies,
    serverChecked,
    ...(serverError ? { serverError } : {})
  }
}
