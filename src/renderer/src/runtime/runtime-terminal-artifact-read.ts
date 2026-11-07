import type { RuntimeReadableFileContent } from './files/runtime-file-client-types'
import { readRemoteFileContent } from './files/reads/runtime-remote-file-content'
import { toRuntimeWorktreeSelector } from './runtime-worktree-selector'
import { chatScratchFileAddress } from './runtime-chat-scratch-file-address'
import {
  acquireTerminalArtifactGrant,
  isRenewableGrantError,
  pinTerminalArtifactGrantTarget,
  renewRestoredHostFileGrant,
  renewTerminalArtifactGrant,
  TERMINAL_ARTIFACT_WRITE_MAX_BYTES,
  type TerminalArtifactGrantTarget
} from './runtime-terminal-artifact-grant'

export async function readHostFilePreview(
  unpinned: TerminalArtifactGrantTarget
): Promise<RuntimeReadableFileContent> {
  const pinned = pinTerminalArtifactGrantTarget(unpinned)
  const granted = await acquireTerminalArtifactGrant(pinned)
  if (!granted) {
    throw new Error(`File not found on its host: ${pinned.absolutePath}`)
  }
  return readRuntimeTerminalArtifactContent(
    { ...pinned, absolutePath: granted.absolutePath, grantId: granted.grantId },
    { pageOversizedBinary: false }
  )
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
  pageOversizedBinary: boolean
}): Promise<RuntimeReadableFileContent> {
  const pinned = pinTerminalArtifactGrantTarget({
    target: args.target,
    worktreeId: args.worktreeId,
    absolutePath: args.filePath,
    expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
  })
  const grantId = args.grantId ?? (await renewRestoredHostFileGrant(pinned))
  return readRuntimeTerminalArtifactContent(
    { ...pinned, grantId },
    { pageOversizedBinary: args.pageOversizedBinary }
  )
}

/** Reads a host file outside every workspace through its grant, renewing a lapsed or stale one. */
export async function readRuntimeTerminalArtifactContent(
  unpinned: TerminalArtifactGrantTarget & { grantId: string },
  options: { pageOversizedBinary: boolean }
): Promise<RuntimeReadableFileContent> {
  const args = pinTerminalArtifactGrantTarget(unpinned)
  try {
    return await readThroughGrant(args, options)
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
  const content = await readThroughGrant({ ...args, grantId: renewed.grantId }, options)
  return renewed.readOnly ? { ...content, readOnly: true } : content
}

async function readThroughGrant(
  args: TerminalArtifactGrantTarget & { grantId: string },
  options: { pageOversizedBinary: boolean }
): Promise<RuntimeReadableFileContent> {
  const content = await readRemoteFileContent(
    {
      target: args.target,
      worktree: toRuntimeWorktreeSelector(args.worktreeId),
      grantId: args.grantId,
      absolutePath: args.absolutePath,
      expectedEnvironmentPairingRevision: args.expectedEnvironmentPairingRevision
    },
    options
  )
  return {
    ...content,
    terminalArtifactGrantId: args.grantId,
    ...(grantCanSave(content) ? {} : { readOnly: true as const })
  }
}

/** A grant saves only text within one write; a larger or binary file opens read-only. */
function grantCanSave(content: RuntimeReadableFileContent): boolean {
  // Why the length first: UTF-8 never takes fewer bytes than UTF-16 units, so long text skips encoding.
  return (
    !content.isBinary &&
    content.content.length <= TERMINAL_ARTIFACT_WRITE_MAX_BYTES &&
    new TextEncoder().encode(content.content).byteLength <= TERMINAL_ARTIFACT_WRITE_MAX_BYTES
  )
}
