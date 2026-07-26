import type { PreloadApi } from '../../../preload/api-types'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { SshConnectionState, SshMutationExpectation } from '../../../shared/ssh-types'
import type { Worktree } from '../../../shared/types'
import { toRuntimeWorktreeSelector } from '../runtime/runtime-worktree-selector'

const SSH_OWNER_CHANGED_MESSAGE =
  "Couldn't verify the SSH connection. Reconnect the host and try again."

type WebFileMutationMethod = Pick<
  NonNullable<PreloadApi['fs']>,
  'writeFile' | 'createFile' | 'createDir' | 'rename' | 'copy' | 'deletePath'
>

type ResolvedWebRuntimeFile = {
  worktree: Pick<Worktree, 'id' | 'hostId'>
  relativePath: string
}

type WebFileMutationSession = {
  resolveFilePath: (filePath: string) => Promise<ResolvedWebRuntimeFile>
  assertMutationSupported: () => Promise<void>
  callRuntimeResult: (method: string, params: unknown) => Promise<unknown>
  getSshState: (targetId: string) => Promise<SshConnectionState | null>
}

type WebFileMutationDependencies = {
  captureSession: () => WebFileMutationSession
}

type WebFileMutationProvenance = SshMutationExpectation & {
  expectedExecutionHostId: 'local' | `ssh:${string}`
}

async function captureWebFileMutationProvenance(
  file: ResolvedWebRuntimeFile,
  getSshState: WebFileMutationSession['getSshState']
): Promise<WebFileMutationProvenance> {
  const host = parseExecutionHostId(file.worktree.hostId)
  if (file.worktree.hostId !== undefined && !host) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  if (!host || host.kind === 'local' || host.kind === 'runtime') {
    return { expectedExecutionHostId: 'local' }
  }

  const state = await getSshState(host.targetId)
  if (state?.targetId !== host.targetId || state.connectionGeneration === undefined) {
    throw new Error(SSH_OWNER_CHANGED_MESSAGE)
  }
  return {
    expectedExecutionHostId: host.id,
    expectedSshTargetId: host.targetId,
    expectedSshConnectionGeneration: state.connectionGeneration
  }
}

function assertSameWorktree(
  source: ResolvedWebRuntimeFile,
  destination: ResolvedWebRuntimeFile
): void {
  if (source.worktree.id !== destination.worktree.id) {
    throw new Error('File operation cannot cross runtime worktrees')
  }
}

export function createWebFileMutationMethods(
  dependencies: WebFileMutationDependencies
): WebFileMutationMethod {
  const callMutation = async (
    session: WebFileMutationSession,
    method: string,
    file: ResolvedWebRuntimeFile,
    params: Record<string, unknown>
  ): Promise<void> => {
    await session.assertMutationSupported()
    const provenance = await captureWebFileMutationProvenance(file, session.getSshState)
    await session.callRuntimeResult(method, {
      worktree: toRuntimeWorktreeSelector(file.worktree.id),
      ...params,
      ...provenance
    })
  }

  return {
    writeFile: async ({ filePath, content }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(filePath)
      await callMutation(session, 'files.write', file, { relativePath: file.relativePath, content })
    },
    createFile: async ({ filePath }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(filePath)
      await callMutation(session, 'files.createFile', file, { relativePath: file.relativePath })
    },
    createDir: async ({ dirPath }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(dirPath)
      await callMutation(session, 'files.createDir', file, { relativePath: file.relativePath })
    },
    rename: async ({ oldPath, newPath }) => {
      const session = dependencies.captureSession()
      const oldFile = await session.resolveFilePath(oldPath)
      const newFile = await session.resolveFilePath(newPath)
      assertSameWorktree(oldFile, newFile)
      await callMutation(session, 'files.rename', oldFile, {
        oldRelativePath: oldFile.relativePath,
        newRelativePath: newFile.relativePath
      })
    },
    copy: async ({ sourcePath, destinationPath }) => {
      const session = dependencies.captureSession()
      const source = await session.resolveFilePath(sourcePath)
      const destination = await session.resolveFilePath(destinationPath)
      assertSameWorktree(source, destination)
      await callMutation(session, 'files.copy', source, {
        sourceRelativePath: source.relativePath,
        destinationRelativePath: destination.relativePath
      })
    },
    deletePath: async ({ targetPath, recursive }) => {
      const session = dependencies.captureSession()
      const file = await session.resolveFilePath(targetPath)
      await callMutation(session, 'files.delete', file, {
        relativePath: file.relativePath,
        recursive
      })
    }
  }
}
