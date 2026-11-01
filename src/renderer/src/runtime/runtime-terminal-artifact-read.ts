import type { RuntimeFilePreviewResult, RuntimeFileReadResult } from '../../../shared/runtime-types'
import { filePreviewExtension } from '../../../shared/file-preview-kind'
import type { RuntimeReadableFileContent } from './runtime-file-client-types'
import { callRuntimeRpc } from './runtime-rpc-client'
import { RuntimeRpcCallError } from './runtime-rpc-result'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { chatScratchFileAddress } from './runtime-chat-scratch-file-address'
import {
  acquireTerminalArtifactGrant,
  isRenewableGrantError,
  pinTerminalArtifactGrantTarget,
  renewRestoredHostFileGrant,
  renewTerminalArtifactGrant,
  type TerminalArtifactGrantTarget
} from './runtime-terminal-artifact-grant'

const EXTENSIONLESS_HOST_PREVIEW_MESSAGE =
  'Cannot preview this extensionless binary file. If it is an image, update Orca on this host and retry.'

export async function readHostFilePreview(
  unpinned: TerminalArtifactGrantTarget
): Promise<RuntimeReadableFileContent> {
  const pinned = pinTerminalArtifactGrantTarget(unpinned)
  const granted = await acquireTerminalArtifactGrant(pinned)
  if (!granted) {
    throw new Error(`File not found on its host: ${pinned.absolutePath}`)
  }
  return readRuntimeTerminalArtifactContent({
    ...pinned,
    absolutePath: granted.absolutePath,
    grantId: granted.grantId
  })
}

/** A granted host file, or a restored tab's absolute host path (grants are never persisted). */
export function isHostFileOutsideWorkspaces(args: {
  filePath: string
  relativePath?: string
  grantId?: string
}): boolean {
  return Boolean(
    args.grantId ?? (args.relativePath === args.filePath && !chatScratchFileAddress(args.filePath))
  )
}

export async function readHostFileOutsideWorkspaces(args: {
  target: TerminalArtifactGrantTarget['target']
  worktreeId: string
  filePath: string
  relativePath?: string
  grantId?: string
  expectedEnvironmentPairingRevision?: number
}): Promise<RuntimeReadableFileContent> {
  const pinned = pinTerminalArtifactGrantTarget({
    target: args.target,
    worktreeId: args.worktreeId,
    absolutePath: args.filePath,
    expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
  })
  const grantId = args.grantId ?? (await renewRestoredHostFileGrant(pinned))
  return readRuntimeTerminalArtifactContent({ ...pinned, grantId })
}

/** Reads a host file outside every workspace through its grant, renewing a lapsed or stale one. */
export async function readRuntimeTerminalArtifactContent(
  unpinned: TerminalArtifactGrantTarget & { grantId: string }
): Promise<RuntimeReadableFileContent> {
  const args = pinTerminalArtifactGrantTarget(unpinned)
  try {
    return await readThroughGrant(args)
  } catch (error) {
    if (!isRenewableGrantError(error)) {
      throw error
    }
  }
  // Why: a file changed on its host stales the tab's grant; Reload and Compare must still read it.
  const renewed = await renewTerminalArtifactGrant(args)
  if (!renewed) {
    throw new Error(`File not found on its host: ${args.absolutePath}`)
  }
  return readThroughGrant({ ...args, grantId: renewed.grantId })
}

async function readThroughGrant(
  args: TerminalArtifactGrantTarget & { grantId: string }
): Promise<RuntimeReadableFileContent> {
  const params = {
    worktree: toRuntimeWorktreeSelector(args.worktreeId),
    grantId: args.grantId,
    absolutePath: args.absolutePath
  }
  try {
    const result = await callRuntimeRpc<RuntimeFileReadResult>(
      args.target,
      'files.readTerminalArtifact',
      params,
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
      }
    )
    if (result.truncated) {
      throw new Error(`Remote file is too large to open in the editor (${result.byteLength} bytes)`)
    }
    return { content: result.content, isBinary: false }
  } catch (error) {
    // Only the host's typed binary refusal permits a preview read through this grant.
    if (!(error instanceof RuntimeRpcCallError && error.message === 'binary_file')) {
      throw error
    }
  }
  try {
    const preview = await callRuntimeRpc<RuntimeFilePreviewResult>(
      args.target,
      'files.readTerminalArtifactPreview',
      params,
      {
        timeoutMs: 15_000,
        expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
      }
    )
    if (
      !filePreviewExtension(args.absolutePath) &&
      preview.isBinary &&
      !preview.isImage &&
      !preview.content
    ) {
      throw new Error(EXTENSIONLESS_HOST_PREVIEW_MESSAGE)
    }
    return preview
  } catch (error) {
    if (
      !filePreviewExtension(args.absolutePath) &&
      error instanceof RuntimeRpcCallError &&
      error.message === 'binary_file'
    ) {
      throw new Error(EXTENSIONLESS_HOST_PREVIEW_MESSAGE)
    }
    throw error
  }
}
