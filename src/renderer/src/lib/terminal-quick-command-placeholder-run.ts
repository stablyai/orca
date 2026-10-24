import { toast } from 'sonner'
import type { TerminalCommandQuickCommand } from '../../../shared/terminal-quick-command-types'
import type { OpenFile } from '@/store/slices/editor'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { resolveWorkspaceDirectory, type WorkspaceDirectoryState } from '@/lib/workspace-directory'
import {
  substituteTerminalQuickCommandPlaceholders,
  terminalQuickCommandUsesPlaceholders,
  type TerminalQuickCommandPlaceholderContext
} from '../../../shared/terminal-quick-command-placeholders'

type PlaceholderEditorFile = Pick<
  OpenFile,
  | 'id'
  | 'filePath'
  | 'relativePath'
  | 'worktreeId'
  | 'mode'
  | 'isUntitled'
  | 'csvPreviewOnly'
  | 'checkRunDetails'
>

type PlaceholderRunState = WorkspaceDirectoryState & {
  openFiles: readonly PlaceholderEditorFile[]
  activeFileIdByWorktree: Record<string, string | null | undefined>
}

export function resolveTerminalQuickCommandPlaceholderContext(
  state: PlaceholderRunState,
  worktreeId: string
): TerminalQuickCommandPlaceholderContext {
  const workspaceFolder = workspaceFolderForWorktree(state, worktreeId)
  const activeId = state.activeFileIdByWorktree[worktreeId]
  const file = activeId ? state.openFiles.find((candidate) => candidate.id === activeId) : undefined
  if (!file || file.worktreeId !== worktreeId || !isRunnableEditorFile(file)) {
    return { filePath: null, relativePath: null, workspaceFolder }
  }
  return {
    filePath: file.filePath,
    relativePath: file.relativePath,
    workspaceFolder: workspaceFolder ?? workspaceFolderFromFile(file)
  }
}

export function prepareTerminalQuickCommandForRun(
  command: TerminalCommandQuickCommand,
  worktreeId: string
): TerminalCommandQuickCommand | null {
  if (!terminalQuickCommandUsesPlaceholders(command.command)) {
    return command
  }
  const result = substituteTerminalQuickCommandPlaceholders(
    command.command,
    resolveTerminalQuickCommandPlaceholderContext(useAppStore.getState(), worktreeId)
  )
  if (result.status === 'ok') {
    return { ...command, command: result.command }
  }
  toast.message(
    result.status === 'missing-file'
      ? translate(
          'components.terminal.quickCommands.missingEditorFile',
          'This command needs an editor file. Open a file in this workspace and try again.'
        )
      : translate(
          'components.terminal.quickCommands.missingWorkspaceFolder',
          'This command needs the workspace folder, which is not available here.'
        )
  )
  return null
}

function isRunnableEditorFile(file: PlaceholderEditorFile): boolean {
  return (
    file.mode === 'edit' &&
    !file.isUntitled &&
    !file.csvPreviewOnly &&
    file.checkRunDetails == null &&
    file.filePath.trim().length > 0
  )
}

function workspaceFolderForWorktree(state: PlaceholderRunState, worktreeId: string): string | null {
  return resolveWorkspaceDirectory(state, worktreeId)
}

function workspaceFolderFromFile(file: PlaceholderEditorFile): string | null {
  const relative = file.relativePath.replace(/\\/g, '/').replace(/^\/+/, '')
  if (!relative) {
    return null
  }
  const normalizedFile = file.filePath.replace(/\\/g, '/')
  if (!normalizedFile.endsWith(relative)) {
    return null
  }
  const folder = file.filePath
    .slice(0, file.filePath.length - relative.length)
    .replace(/[\\/]+$/, '')
  return folder.length > 0 ? folder : null
}
