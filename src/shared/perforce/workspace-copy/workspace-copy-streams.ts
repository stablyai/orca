import type { WorkspaceCopyHost } from './workspace-copy-host'
import { streamShortName } from './workspace-copy-name-rules'
import { p4Tagged } from './workspace-copy-p4'
import { resolveCopySource } from './workspace-copy-source'
import type { PerforceStreamList } from './workspace-copy-types'

/** Streams a copy of the workspace at `dir` can go on: every stream in the source stream's depot. */
export async function listCopyStreams(
  host: WorkspaceCopyHost,
  dir: string
): Promise<PerforceStreamList> {
  const source = await resolveCopySource(host, dir)
  const depot = /^\/\/[^/]+/.exec(source.stream)?.[0]
  if (!depot) {
    return { sourceStream: source.stream, streams: [] }
  }
  const records = await p4Tagged(
    host,
    ['streams', '-T', 'Stream,Type,Parent,Name', `${depot}/...`],
    source.root
  )
  const streams = records
    .filter((record) => record.Stream?.startsWith('//'))
    .map((record) => ({
      stream: record.Stream,
      name: record.Name ?? streamShortName(record.Stream),
      type: record.Type ?? '',
      parent: record.Parent && record.Parent !== 'none' ? record.Parent : null
    }))
    .sort((a, b) => a.stream.localeCompare(b.stream))
  return { sourceStream: source.stream, streams }
}
