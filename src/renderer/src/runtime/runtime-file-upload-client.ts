import { joinPath, normalizeRelativePath } from '@/lib/path'
import type { RuntimeFileOperationArgs } from './runtime-file-client-types'
import {
  callRuntimeFileImportMutation,
  type RuntimeFileImportSession
} from './runtime-file-mutation-rpc'
import {
  getRemoteFileArgs,
  joinRuntimeRelativePath,
  withSshMutationExpectation
} from './runtime-file-routing'
import { runtimePathExists } from './runtime-file-metadata-client'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'

const REMOTE_UPLOAD_BASE64_CHUNK_CHARS = 512 * 1024

export async function uploadRuntimeFileWithoutClobber(
  session: RuntimeFileImportSession,
  worktreeId: string,
  relativePath: string,
  contentBase64: string,
  expectedSshConnectionGeneration?: number,
  expectedSshTargetId?: string,
  expectedExecutionHostId?: 'local' | `ssh:${string}`
): Promise<void> {
  const tempRelativePath = makeRuntimeUploadTempPath(relativePath)
  try {
    await writeRuntimeBase64File(
      session,
      worktreeId,
      tempRelativePath,
      contentBase64,
      expectedSshConnectionGeneration,
      expectedSshTargetId,
      expectedExecutionHostId
    )
    await callRuntimeFileImportMutation(
      session,
      'files.commitUpload',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        tempRelativePath,
        finalRelativePath: relativePath,
        expectedSshTargetId,
        expectedSshConnectionGeneration,
        expectedExecutionHostId
      },
      30_000
    )
  } finally {
    await callRuntimeFileImportMutation(
      session,
      'files.delete',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        relativePath: tempRelativePath,
        recursive: false,
        expectedSshTargetId,
        expectedSshConnectionGeneration,
        expectedExecutionHostId
      },
      15_000
    ).catch(() => {})
  }
}

async function writeRuntimeBase64File(
  session: RuntimeFileImportSession,
  worktreeId: string,
  relativePath: string,
  contentBase64: string,
  expectedSshConnectionGeneration?: number,
  expectedSshTargetId?: string,
  expectedExecutionHostId?: 'local' | `ssh:${string}`
): Promise<void> {
  if (contentBase64.length <= REMOTE_UPLOAD_BASE64_CHUNK_CHARS) {
    await callRuntimeFileImportMutation(
      session,
      'files.writeBase64',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        relativePath,
        contentBase64,
        expectedSshTargetId,
        expectedSshConnectionGeneration,
        expectedExecutionHostId
      },
      30_000
    )
    return
  }

  for (let offset = 0; offset < contentBase64.length; offset += REMOTE_UPLOAD_BASE64_CHUNK_CHARS) {
    await callRuntimeFileImportMutation(
      session,
      'files.writeBase64Chunk',
      {
        worktree: toRuntimeWorktreeSelector(worktreeId),
        relativePath,
        contentBase64: contentBase64.slice(offset, offset + REMOTE_UPLOAD_BASE64_CHUNK_CHARS),
        append: offset > 0,
        expectedSshTargetId,
        expectedSshConnectionGeneration,
        expectedExecutionHostId
      },
      30_000
    )
  }
}

function makeRuntimeUploadTempPath(relativePath: string): string {
  const normalized = normalizeRelativePath(relativePath)
  const slashIndex = normalized.lastIndexOf('/')
  const dir = slashIndex === -1 ? '' : normalized.slice(0, slashIndex + 1)
  const leaf = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1)
  const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  return `${dir}.${leaf}.orca-upload-${nonce}`
}

export async function ensureRuntimeDirectory(
  context: RuntimeFileOperationArgs,
  destinationDir: string,
  session: RuntimeFileImportSession
): Promise<void> {
  const destinationArgs = getRemoteFileArgs(context, destinationDir)
  if (!destinationArgs) {
    return
  }
  const parts = normalizeRelativePath(destinationArgs.relativePath)
    .split('/')
    .filter((part) => part.length > 0)
  let current = ''
  for (const part of parts) {
    current = joinRuntimeRelativePath(current, part)
    const absolutePath = joinPath(context.worktreePath ?? '', current)
    session.assertCurrent()
    if (
      await runtimePathExists(context, absolutePath, session.expectedEnvironmentPairingRevision)
    ) {
      continue
    }
    await callRuntimeFileImportMutation(
      session,
      'files.createDir',
      withSshMutationExpectation(context, {
        worktree: destinationArgs.worktreeSelector,
        relativePath: current
      }),
      15_000
    )
  }
}
