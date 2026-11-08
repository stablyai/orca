import {
  createPathExistenceBatch,
  type PathExistenceResult
} from '../../../../../../shared/path-existence-batch'
import type { RuntimeFileOperationArgs } from '@/runtime/files/runtime-file-client-types'
import { runtimePathsExist } from '@/runtime/files/metadata/runtime-path-existence-batch'
import { captureRuntimeEnvironmentRequestRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'

type PathGroup = {
  context: RuntimeFileOperationArgs
  remote: boolean
  pairingRevision?: number
}

async function pathGroupExistence(
  group: PathGroup,
  paths: string[]
): Promise<PathExistenceResult[]> {
  if (group.context.connectionId || group.remote) {
    return runtimePathsExist(group.context, paths, group.pairingRevision)
  }
  const values = window.api.shell.pathsExist
    ? await window.api.shell.pathsExist(paths)
    : await Promise.all(paths.map((path) => window.api.shell.pathExists(path)))
  if (values.length !== paths.length) {
    throw new Error('Invalid local path existence response')
  }
  return values.map((value): PathExistenceResult => {
    if (typeof value === 'boolean') {
      return { exists: value }
    }
    // A refused path (e.g. in a stopped WSL distro) is unverifiable, never missing.
    if (value && typeof value === 'object' && typeof value.error === 'string') {
      return { error: value.error }
    }
    throw new Error('Invalid local path existence response')
  })
}

/** One hover turn shares a host request; no answers survive into another turn. */
export function createTerminalPathExistenceBatch(): (
  context: RuntimeFileOperationArgs,
  path: string,
  remote: boolean
) => Promise<boolean> {
  const enqueue = createPathExistenceBatch<PathGroup>({
    groupKey: ({ context, remote, pairingRevision }) =>
      JSON.stringify([
        context.target.kind === 'environment' ? context.target.environmentId : null,
        context.worktreeId,
        context.worktreePath,
        context.connectionId,
        pairingRevision,
        remote
      ]),
    run: pathGroupExistence
  })
  return (context, path, remote) => {
    const target = context.target
    const pairingRevision =
      target.kind === 'environment'
        ? captureRuntimeEnvironmentRequestRevision(target.environmentId)
        : undefined
    return enqueue({ context, remote, pairingRevision }, path)
  }
}
