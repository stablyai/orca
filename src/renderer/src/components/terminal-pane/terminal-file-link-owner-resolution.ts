import { statUserOpenedPath } from '@/lib/user-opened-local-path'
import type { TerminalFileContext } from './terminal-file-path-mapping'
import {
  CLIENT_LOCAL_FILE_TARGET,
  resolveHostWorkspaceFile,
  type HostWorkspaceFile
} from './terminal-host-workspace-file'

export type TerminalLinkFileOwner = {
  fileContext: TerminalFileContext
  worktreeId: string
  worktreePath: string
  /** The path to open: the host's spelling when the host resolved it. */
  filePath: string
  stat: { isDirectory: boolean; escapesWorktree: boolean }
  /** Another host workspace the link opens in. */
  hostWorkspaceFile: HostWorkspaceFile | null
  hostGrantId: string | null
  clientLocal: boolean
}

/**
 * Who owns a clicked link's file and how it may be read: a host grant, this computer, another
 * workspace on the host (opened there), or the source workspace. Throws when the host cannot answer.
 */
export async function resolveTerminalLinkFileOwner(args: {
  fileContext: TerminalFileContext
  worktreeId: string
  worktreePath: string
  filePath: string
  terminalHandle?: string | null
}): Promise<TerminalLinkFileOwner> {
  const { fileContext, filePath } = args
  const resolved: TerminalLinkFileOwner = {
    fileContext,
    worktreeId: args.worktreeId,
    worktreePath: args.worktreePath,
    filePath,
    stat: { isDirectory: false, escapesWorktree: false },
    hostWorkspaceFile: null,
    hostGrantId: null,
    clientLocal: false
  }
  const linkOwner = await resolveHostWorkspaceFile(fileContext, filePath, args.terminalHandle)
  if (linkOwner?.kind === 'grant') {
    return {
      ...resolved,
      hostGrantId: linkOwner.grantId,
      filePath: linkOwner.absolutePath,
      stat: { isDirectory: false, escapesWorktree: true }
    }
  }
  if (linkOwner?.kind === 'client') {
    return {
      ...resolved,
      clientLocal: true,
      fileContext: { ...fileContext, target: CLIENT_LOCAL_FILE_TARGET, connectionId: undefined },
      stat: { isDirectory: linkOwner.isDirectory, escapesWorktree: false }
    }
  }
  if (!linkOwner) {
    return { ...resolved, stat: await statUserOpenedPath(fileContext, filePath) }
  }
  // Why: the host already stat'ed the path inside the workspace that holds it; open it there.
  const { worktreeId, worktreePath } = linkOwner
  return {
    ...resolved,
    filePath: linkOwner.absolutePath,
    hostWorkspaceFile: linkOwner,
    worktreeId,
    worktreePath,
    fileContext: { ...fileContext, worktreeId, worktreePath },
    stat: { isDirectory: linkOwner.isDirectory, escapesWorktree: false }
  }
}
