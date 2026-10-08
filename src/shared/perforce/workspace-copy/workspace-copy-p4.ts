import { parseTaggedOutput, type P4Record } from '../p4-tagged-output'
import { WorkspaceCopyError } from './workspace-copy-errors'
import type { WorkspaceCopyHost } from './workspace-copy-host'

/** Client-relative path (case-insensitive key, as Windows workspaces are) -> its spelling and a value. */
export type ClientPathMap = Map<string, { rel: string; value: string }>

export const OPEN_FOR_NEW_FILE = new Set(['add', 'branch', 'move/add', 'import'])

export function unescapeP4Path(path: string): string {
  return path
    .replaceAll('%40', '@')
    .replaceAll('%23', '#')
    .replaceAll('%2A', '*')
    .replaceAll('%25', '%')
}

export async function p4OrThrow(
  host: WorkspaceCopyHost,
  args: readonly string[],
  cwd: string,
  input?: string
): Promise<string> {
  const result = await host.p4(args, { cwd, input })
  if (result.code !== 0) {
    const detail = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join(' ')
    throw new WorkspaceCopyError('perforce', `p4 ${args.join(' ')} failed: ${detail}`)
  }
  return result.stdout
}

export async function p4Tagged(
  host: WorkspaceCopyHost,
  args: readonly string[],
  cwd: string
): Promise<P4Record[]> {
  return parseTaggedOutput((await host.p4(['-ztag', ...args], { cwd })).stdout)
}

export async function findClient(
  host: WorkspaceCopyHost,
  client: string,
  cwd: string
): Promise<P4Record | null> {
  const records = await p4Tagged(host, ['clients', '-E', client], cwd)
  return records.find((record) => record.client?.toLowerCase() === client.toLowerCase()) ?? null
}

export async function listClientsWithPrefix(
  host: WorkspaceCopyHost,
  prefix: string,
  cwd: string
): Promise<P4Record[]> {
  const output = await p4OrThrow(host, ['-ztag', 'clients', '-E', `${prefix}*`], cwd)
  const lower = prefix.toLowerCase()
  return parseTaggedOutput(output).filter((record) =>
    record.client?.toLowerCase().startsWith(lower)
  )
}

export async function findStream(
  host: WorkspaceCopyHost,
  stream: string,
  cwd: string
): Promise<P4Record | null> {
  const records = await p4Tagged(host, ['streams', stream], cwd)
  return records.find((record) => record.Stream?.toLowerCase() === stream.toLowerCase()) ?? null
}

export async function openedRecords(
  host: WorkspaceCopyHost,
  client: string,
  cwd: string
): Promise<P4Record[]> {
  const result = await host.p4(['-ztag', '-c', client, 'opened', '-C', client], { cwd })
  if (result.code !== 0 && !/not opened/i.test(result.stderr)) {
    throw new WorkspaceCopyError(
      'perforce',
      `p4 opened -C ${client} failed: ${result.stderr.trim()}`
    )
  }
  return parseTaggedOutput(result.stdout).filter((record) => record.clientFile)
}

export async function pendingChanges(
  host: WorkspaceCopyHost,
  client: string,
  cwd: string
): Promise<{ change: number; description: string }[]> {
  const records = await p4Tagged(host, ['changes', '-l', '-s', 'pending', '-c', client], cwd)
  return records
    .filter((record) => record.change)
    .map((record) => ({
      change: Number(record.change),
      description: (record.desc ?? '').trim()
    }))
}

export async function shelvedFileCount(
  host: WorkspaceCopyHost,
  change: number,
  cwd: string
): Promise<number> {
  const records = await p4Tagged(host, ['describe', '-S', '-s', String(change)], cwd)
  return records.reduce(
    (count, record) => count + Object.keys(record).filter((k) => /^depotFile\d*$/.test(k)).length,
    0
  )
}

export async function submittedChangeCount(
  host: WorkspaceCopyHost,
  stream: string,
  cwd: string
): Promise<number> {
  const records = await p4Tagged(host, ['changes', '-m1', '-s', 'submitted', `${stream}/...`], cwd)
  return records.filter((record) => record.change).length
}

/** Reads `field` for every have-revision of `client` as one `-F` line per file. */
async function readClientPathMap(
  host: WorkspaceCopyHost,
  client: string,
  cwd: string,
  args: readonly string[],
  field: string
): Promise<ClientPathMap> {
  const prefix = `//${client}/`.toLowerCase()
  const result = await host.p4(['-ztag', '-F', `%clientFile%|%${field}%`, '-c', client, ...args], {
    cwd
  })
  const tolerated = /file\(s\) not on client|no such file|not in client view/i
  if (result.code !== 0 && !tolerated.test(result.stderr)) {
    throw new WorkspaceCopyError('perforce', `p4 ${args[0]} failed: ${result.stderr.trim()}`)
  }
  const map: ClientPathMap = new Map()
  for (const line of result.stdout.split(/\r?\n/)) {
    const bar = line.lastIndexOf('|')
    if (bar <= 0 || !line.toLowerCase().startsWith(prefix)) {
      continue
    }
    const rel = unescapeP4Path(line.slice(prefix.length, bar))
    map.set(rel.toLowerCase(), { rel, value: line.slice(bar + 1).trim() })
  }
  return map
}

export function haveRevisions(
  host: WorkspaceCopyHost,
  client: string,
  cwd: string
): Promise<ClientPathMap> {
  return readClientPathMap(host, client, cwd, ['have', `//${client}/...`], 'haveRev')
}

/** The server's digest of each have revision; compares two workspaces without reading their files. */
export async function haveDigests(
  host: WorkspaceCopyHost,
  client: string,
  cwd: string
): Promise<ClientPathMap> {
  // -Op prints clientFile in //client/ syntax; without it the paths are host paths and nothing matches.
  const args = ['fstat', '-Olp', '-T', 'clientFile,digest', `//${client}/...#have`]
  const map = await readClientPathMap(host, client, cwd, args, 'digest')
  if (map.size === 0) {
    // Why: an empty map would read as "nothing differs" and leave the copy silently wrong.
    throw new WorkspaceCopyError(
      'perforce',
      `p4 fstat returned no have-list for ${client}; the copy cannot be matched to its stream.`
    )
  }
  return map
}

/**
 * `sync -f` of each spec (one per stdin line). With `tolerated`, any other stderr line fails it
 * (p4 exits 0 on most per-file errors); without, a non-zero exit does.
 */
export async function forceSync(
  host: WorkspaceCopyHost,
  client: string,
  cwd: string,
  specs: readonly string[],
  tolerated?: RegExp
): Promise<string> {
  if (specs.length === 0) {
    return ''
  }
  const quiet = tolerated ? [] : ['-q']
  const result = await host.p4(['-x', '-', ...quiet, '-c', client, 'sync', '-f'], {
    cwd,
    input: `${specs.join('\n')}\n`
  })
  const lines = result.stderr.split(/\r?\n/).filter((line) => line.trim())
  const unexpected = tolerated ? lines.filter((line) => !tolerated.test(line)) : lines
  if (tolerated ? unexpected.length > 0 : result.code !== 0) {
    throw new WorkspaceCopyError('perforce', `p4 sync -f failed: ${unexpected.join(' ')}`)
  }
  return result.stdout
}
