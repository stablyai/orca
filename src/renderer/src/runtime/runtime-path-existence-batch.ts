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
import {
  callRuntimeRpc,
  runtimeEnvironmentSupportsCapability,
  RuntimeRpcCallError
} from './runtime-rpc-client'

export async function runtimePathsExist(
  context: RuntimeFileOperationArgs,
  paths: string[],
  expectedPairingRevision?: number
): Promise<PathExistenceResult[]> {
  const routes = paths.map((path) => getRemoteFileArgs(context, path))
  const first = routes[0]

  const expectedEnvironmentPairingRevision = first
    ? captureRuntimeEnvironmentRequestRevision(first.target.environmentId, expectedPairingRevision)
    : undefined

  const fallback = () =>
    Promise.all(
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

    // Preserve runtimePathExists's legacy missing-error interpretation.
    return result.map((row) =>
      'error' in row && isMissingRuntimePathError(row.error) ? { exists: false } : row
    )
  } catch (error) {
    if (error instanceof RuntimeRpcCallError && error.code === 'method_not_found') {
      return fallback()
    }

    if (isMissingRuntimePathError(error)) {
      return paths.map(() => ({ exists: false }))
    }

    throw error
  }
}
