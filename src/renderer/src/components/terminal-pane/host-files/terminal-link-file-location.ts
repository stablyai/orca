import { statUserOpenedPath } from '@/lib/files/access/user-opened-local-path'
import type { TerminalFileContext } from './terminal-file-path-mapping'
import {
  CLIENT_LOCAL_FILE_TARGET,
  hostGrantedEditorFields,
  resolveHostWorkspaceFile
} from './terminal-host-workspace-file'
import type { HostWorkspaceFile } from './terminal-host-workspace-file'

export type ResolvedLinkFile = {
  fileContext: TerminalFileContext
  mappedFilePath: string
  worktreeId: string
  worktreePath: string
  hostWorkspaceFile: HostWorkspaceFile | null
  hostGrant: ReturnType<typeof hostGrantedEditorFields> | null
  clientLocal: boolean
  statResult: { isDirectory: boolean; escapesWorktree: boolean }
}

/** Where a link's path actually lives: the owner's workspace, a host grant, or this computer. */
export async function resolveLinkFileLocation(
  fileContext: TerminalFileContext,
  mappedFilePath: string,
  deps: {
    worktreeId: string
    worktreePath: string
    terminalHandle?: string | null
    hostFileOnly?: boolean
    openWithSystemDefault?: boolean
  }
): Promise<ResolvedLinkFile> {
  let { worktreeId, worktreePath } = deps
  let hostWorkspaceFile: HostWorkspaceFile | null = null
  let hostGrant: ResolvedLinkFile['hostGrant'] = null
  let clientLocal = false
  let statResult: ResolvedLinkFile['statResult']
  const linkOwner = await resolveHostWorkspaceFile(fileContext, mappedFilePath, {
    ...deps,
    openWithSystemDefault: deps.openWithSystemDefault
  })
  if (linkOwner?.kind === 'grant') {
    hostGrant = hostGrantedEditorFields(linkOwner)
    mappedFilePath = linkOwner.absolutePath
    statResult = { isDirectory: false, escapesWorktree: true }
  } else if (linkOwner?.kind === 'client') {
    clientLocal = true
    fileContext = { ...fileContext, target: CLIENT_LOCAL_FILE_TARGET, connectionId: undefined }
    statResult = { isDirectory: linkOwner.isDirectory, escapesWorktree: false }
  } else if (linkOwner) {
    hostWorkspaceFile = linkOwner
    // Why: the host already stat'ed the path inside the workspace that holds it; open it there.
    ;({ worktreeId, worktreePath, absolutePath: mappedFilePath } = hostWorkspaceFile)
    fileContext = { ...fileContext, worktreeId, worktreePath }
    statResult = { isDirectory: hostWorkspaceFile.isDirectory, escapesWorktree: false }
  } else {
    statResult = await statUserOpenedPath(fileContext, mappedFilePath)
  }
  return {
    fileContext,
    mappedFilePath,
    worktreeId,
    worktreePath,
    hostWorkspaceFile,
    hostGrant,
    clientLocal,
    statResult
  }
}
