import {
  capturePathExistence,
  PATH_EXISTENCE_BATCH_CAPABILITY,
  requirePathExistenceResults,
  type PathExistenceResult
} from '../../../shared/path-existence-batch'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import { assertLocalFilesystemFallbackAllowed, getRemoteFileArgs } from './runtime-file-routing'
import { isMissingRuntimePathError, runtimePathExists } from './runtime-file-metadata-client'
import { captureRuntimeEnvironmentRequestRevision } from './runtime-environment-revision'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'

// Machine token, not UI copy: callers treat any error row as "cannot tell".
const UNVERIFIABLE_PATH_EXISTENCE = 'unverifiable'

/**
 * `codedAbsenceOnly`: report `exists: false` only from a per-path ENOENT, never from a message match
 * or a whole-request "not found"; anything less certain comes back as an error row.
 */
export async function runtimePathsExist(
  context: RuntimeFileOperationArgs,
  paths: string[],
  expectedPairingRevision?: number,
  options: { codedAbsenceOnly?: boolean } = {}
): Promise<PathExistenceResult[]> {
  const unverifiable = (): PathExistenceResult[] =>
    paths.map(() => ({ error: UNVERIFIABLE_PATH_EXISTENCE }))
  const routes = paths.map((path) => getRemoteFileArgs(context, path))
  const first = routes[0]
  const expectedEnvironmentPairingRevision = first
    ? captureRuntimeEnvironmentRequestRevision(first.target.environmentId, expectedPairingRevision)
    : undefined
  const fallback = async (): Promise<PathExistenceResult[]> =>
    options.codedAbsenceOnly
      ? unverifiable()
      : Promise.all(
          paths.map((path) =>
            capturePathExistence(() =>
              runtimePathExists(context, path, expectedEnvironmentPairingRevision)
            )
          )
        )
  if (!first || routes.some((route) => !route)) {
    if (routes.every((route) => !route) && window.api.fs.pathsExist) {
      // Scalar routing performs the same ownership fence before local IPC.
      assertLocalFilesystemFallbackAllowed(context)
      return requirePathExistenceResults(
        await window.api.fs.pathsExist({ filePaths: paths, connectionId: context.connectionId }),
        paths.length
      )
    }
    return fallback()
  }
  try {
    if (
      !(await runtimeEnvironmentSupportsCapability(
        first.target.environmentId,
        PATH_EXISTENCE_BATCH_CAPABILITY,
        15_000
      ))
    ) {
      return fallback()
    }
    const result = requirePathExistenceResults(
      await callRuntimeRpc(
        first.target,
        'files.pathsExist',
        {
          worktree: first.worktreeSelector,
          relativePaths: routes.map((route) => route!.relativePath)
        },
        { timeoutMs: 15_000, expectedEnvironmentPairingRevision }
      ),
      paths.length
    )
    if (options.codedAbsenceOnly) {
      return result
    }
    // Preserve runtimePathExists's legacy missing-error interpretation.
    return result.map((row) =>
      'error' in row && isMissingRuntimePathError(row.error) ? { exists: false } : row
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return fallback()
    }
    if (!options.codedAbsenceOnly && isMissingRuntimePathError(error)) {
      return paths.map(() => ({ exists: false }))
    }
    throw error
  }
}
