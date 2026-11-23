import { browseRuntimeServerDirectory } from '@/runtime/files/reads/runtime-server-directory-browser'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { RuntimeRpcCallError } from '@/runtime/rpc/calls/runtime-rpc-result'
import { getDefaultCreateProjectParent } from './create-project-defaults'

/** The parent the runtime host suggests for Create project, from its own Workspace Directory setting. */
export async function getRuntimeDefaultCreateProjectParent(
  environmentId: string,
  timeoutMs: number
): Promise<string> {
  try {
    const result = await callRuntimeRpc<{ parentPath: string }>(
      { kind: 'environment', environmentId },
      'repo.defaultCreateParent',
      undefined,
      { timeoutMs }
    )
    return result.parentPath
  } catch (error) {
    if (!(error instanceof RuntimeRpcCallError) || error.code !== 'method_not_found') {
      throw error
    }
    // Older hosts can't read their settings for us; keep their previous <home>/orca/projects suggestion.
    const home = await browseRuntimeServerDirectory(environmentId, '~')
    return getDefaultCreateProjectParent(home.resolvedPath)
  }
}
