import { getConnectionIdForFile } from '@/lib/connection-context'
import { joinAbsolutePath, normalizeAbsolutePath } from '@/lib/terminal-path-normalization'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { statRuntimePath } from '@/runtime/runtime-file-client'
import { useAppStore } from '@/store'
import {
  getTerminalFileContext,
  openDetectedFilePath,
  shouldOpenTerminalFileWithSystemDefault
} from './terminal-file-open-routing'

export type TerminalRichInputPathContext = {
  path: string
  connectionId: string | null
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
}

type TerminalRichInputPathKind = 'file' | 'directory'

type TerminalRichInputPathNavigationDeps = {
  inspectPath: (
    absolutePath: string,
    context: TerminalRichInputPathContext
  ) => Promise<TerminalRichInputPathKind | null>
  isContextCurrent?: (context: TerminalRichInputPathContext, absolutePath: string) => boolean
  openFile: (absolutePath: string, context: Omit<TerminalRichInputPathContext, 'path'>) => void
  revealDirectory: (absolutePath: string, context: TerminalRichInputPathContext) => void
}

export function resolveTerminalRichInputAbsolutePath(
  path: string,
  worktreePath: string
): string | null {
  return normalizeAbsolutePath(path)?.normalized ?? joinAbsolutePath(worktreePath, path)
}

export async function inspectTerminalRichInputPath(
  absolutePath: string,
  context: TerminalRichInputPathContext
): Promise<TerminalRichInputPathKind | null> {
  try {
    const stats = await statRuntimePath(
      getTerminalFileContext(
        context.worktreeId,
        context.worktreePath,
        context.runtimeEnvironmentId,
        context.connectionId
      ),
      absolutePath
    )
    return stats.isDirectory ? 'directory' : 'file'
  } catch {
    return null
  }
}

async function inspectTerminalRichInputPathForActivation(
  absolutePath: string,
  context: TerminalRichInputPathContext
): Promise<TerminalRichInputPathKind | null> {
  const fileContext = getTerminalFileContext(
    context.worktreeId,
    context.worktreePath,
    context.runtimeEnvironmentId,
    context.connectionId
  )
  if (shouldOpenTerminalFileWithSystemDefault(fileContext, absolutePath)) {
    try {
      await window.api.fs.authorizeExternalPath({ targetPath: absolutePath })
    } catch {
      return null
    }
  }
  return inspectTerminalRichInputPath(absolutePath, context)
}

export function isTerminalRichInputPathContextCurrent(
  context: TerminalRichInputPathContext,
  absolutePath: string
): boolean {
  const state = useAppStore.getState()
  const currentConnectionId = getConnectionIdForFile(context.worktreeId, absolutePath)
  const currentRuntimeEnvironmentId = getRuntimeEnvironmentIdForWorktree(state, context.worktreeId)
  return (
    currentConnectionId !== undefined &&
    currentConnectionId === context.connectionId &&
    currentRuntimeEnvironmentId === context.runtimeEnvironmentId
  )
}

const defaultNavigationDeps: TerminalRichInputPathNavigationDeps = {
  inspectPath: inspectTerminalRichInputPathForActivation,
  openFile: (absolutePath, context) =>
    openDetectedFilePath(absolutePath, null, null, {
      connectionId: context.connectionId,
      worktreeId: context.worktreeId,
      worktreePath: context.worktreePath,
      runtimeEnvironmentId: context.runtimeEnvironmentId
    }),
  isContextCurrent: isTerminalRichInputPathContextCurrent,
  revealDirectory: (absolutePath, context) => {
    activateAndRevealWorktree(context.worktreeId)
    useAppStore.getState().revealInExplorer(context.worktreeId, absolutePath)
  }
}

export async function navigateTerminalRichInputPath(
  context: TerminalRichInputPathContext,
  deps: TerminalRichInputPathNavigationDeps = defaultNavigationDeps
): Promise<void> {
  const absolutePath = resolveTerminalRichInputAbsolutePath(context.path, context.worktreePath)
  if (!absolutePath) {
    return
  }
  const kind = await deps.inspectPath(absolutePath, context)
  if (kind === 'directory') {
    if (deps.isContextCurrent && !deps.isContextCurrent(context, absolutePath)) {
      return
    }
    deps.revealDirectory(absolutePath, context)
    return
  }
  if (kind === 'file') {
    deps.openFile(absolutePath, {
      connectionId: context.connectionId,
      worktreeId: context.worktreeId,
      worktreePath: context.worktreePath,
      runtimeEnvironmentId: context.runtimeEnvironmentId
    })
  }
}
