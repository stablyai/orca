import { WorkspaceCopyError } from './workspace-copy-errors'
import type { WorkspaceCopyHost } from './workspace-copy-host'
import { copyNamesFor, type WorkspaceCopyNames } from './workspace-copy-names'
import {
  findClient,
  findStream,
  openedRecords,
  pendingChanges,
  shelvedFileCount,
  submittedChangeCount,
  unescapeP4Path
} from './workspace-copy-p4'
import { processesUnder, processLabel } from './workspace-copy-processes'
import { isCopyOwnStream } from './workspace-copy-stream-choice'
import {
  isPathUnder,
  normalizePath,
  pathExists,
  resolveCopySource,
  samePath,
  type CopySource
} from './workspace-copy-source'
import type {
  WorkspaceCopyPendingChange,
  WorkspaceCopyRemovalPreview
} from './workspace-copy-types'

const OPEN_FILE_SAMPLE = 20

export type RemovalPlan = WorkspaceCopyRemovalPreview & {
  source: CopySource
  names: WorkspaceCopyNames
  markerExists: boolean
}

/**
 * Everything removing copy `name` of `source` would do, read before anything changes so
 * the confirmation can say it. Refuses a client whose root is not the copy folder Orca expects: the
 * folder is deleted, so it must be one only a copy can own.
 */
export async function planWorkspaceCopyRemoval(
  host: WorkspaceCopyHost,
  source: CopySource,
  name: string
): Promise<RemovalPlan> {
  const names = copyNamesFor(source, name)
  const record = await findClient(host, names.client, source.root)
  if (record?.Root && !samePath(normalizePath(record.Root), names.copyRoot)) {
    throw new WorkspaceCopyError(
      'refused',
      `Client ${names.client} is rooted at ${record.Root}, not at the copy folder ${names.copyRoot}. Orca only deletes folders it can recognise as copies; remove this client in P4V.`
    )
  }
  if (isPathUnder(source.root, names.copyRoot)) {
    throw new WorkspaceCopyError('refused', `${names.copyRoot} contains the original workspace.`)
  }
  const folderExists = await pathExists(names.copyRoot)
  const markerExists = await pathExists(names.markerPath)
  if (!record && !folderExists && !markerExists) {
    throw new WorkspaceCopyError('refused', `No copy named ${name}.`)
  }
  const opened = record ? await openedRecords(host, names.client, source.root) : []
  const pending = record ? await pendingChanges(host, names.client, source.root) : []
  const changes: WorkspaceCopyPendingChange[] = []
  for (const change of pending) {
    changes.push({
      ...change,
      shelvedFiles: await shelvedFileCount(host, change.change, source.root)
    })
  }
  const stream = record?.Stream || null
  let childStream: WorkspaceCopyRemovalPreview['childStream'] = null
  if (stream && isCopyOwnStream(stream, name)) {
    const streamRecord = await findStream(host, stream, source.root)
    childStream = {
      stream,
      submittedChanges: await submittedChangeCount(host, stream, source.root),
      parent: streamRecord?.Parent ?? null
    }
  }
  const holders = folderExists ? await processesUnder(host, names.copyRoot) : []
  const prefix = `//${names.client}/`.toLowerCase()
  return {
    source,
    names,
    markerExists,
    name,
    client: names.client,
    copyRoot: names.copyRoot,
    markerPath: names.markerPath,
    clientExists: record !== null,
    folderExists,
    stream,
    openFiles: {
      count: opened.length,
      sample: opened.slice(0, OPEN_FILE_SAMPLE).map((file) => {
        const clientFile = file.clientFile ?? ''
        return clientFile.toLowerCase().startsWith(prefix)
          ? unescapeP4Path(clientFile.slice(prefix.length))
          : clientFile
      })
    },
    pendingChanges: changes,
    childStream,
    processesHoldingFolder: holders.map(processLabel),
    holders,
    blockers: {
      openFiles: opened.length > 0,
      shelves: changes.some((change) => change.shelvedFiles > 0),
      holders: holders.length > 0
    }
  }
}

/** What removing copy `name` of the workspace at `dir` would do, for the confirmation. */
export async function previewWorkspaceCopyRemoval(
  host: WorkspaceCopyHost,
  dir: string,
  name: string
): Promise<WorkspaceCopyRemovalPreview> {
  const {
    source: _source,
    names: _names,
    markerExists: _marker,
    ...preview
  } = await planWorkspaceCopyRemoval(host, await resolveCopySource(host, dir), name)
  return preview
}
