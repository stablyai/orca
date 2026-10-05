import type { OpenFile } from '@/store/slices/editor'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'

export function getEditorExternalWatchTargetKey(target: EditorExternalWatchTarget): string {
  // Why: include connectionId so a local placeholder watch is replaced by the real SSH watch once an SSH worktree's provider metadata hydrates.
  return `${target.worktreeId}::${target.worktreePath}::${target.connectionId ?? 'local'}::${target.runtimeEnvironmentId ?? 'client'}::${target.allowLocalWindowsWslAliases === true ? 'wsl-aliases' : 'literal'}${target.shallow ? '::shallow' : ''}`
}

export function getOpenFileRuntimeOwner(
  file: Pick<OpenFile, 'runtimeEnvironmentId'>
): string | null {
  return file.runtimeEnvironmentId?.trim() || null
}
