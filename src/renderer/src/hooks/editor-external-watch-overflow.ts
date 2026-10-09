import { useAppStore } from '@/store'
import { isExternalReloadableEditorTab } from '@/components/editor/editor-autosave'
import {
  getLocalWindowsWslAliasOption,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import type { EditorExternalWatchNotification } from './editor-external-watch-disk-verification'

export function collectOverflowEditorExternalReloadTargets(
  target: Pick<EditorExternalWatchTarget, 'worktreeId' | 'worktreePath'> &
    Partial<
      Pick<
        EditorExternalWatchTarget,
        'connectionId' | 'runtimeEnvironmentId' | 'allowLocalWindowsWslAliases'
      >
    >
): EditorExternalWatchNotification[] {
  const state = useAppStore.getState()
  const notifications: EditorExternalWatchNotification[] = []
  for (const file of state.openFiles) {
    if (
      file.worktreeId !== target.worktreeId ||
      getOpenFileRuntimeOwner(file) !== (target.runtimeEnvironmentId ?? null) ||
      !isExternalReloadableEditorTab(file) ||
      file.isDirty
    ) {
      continue
    }
    if (file.externalMutation) {
      state.setExternalMutation(file.id, null)
    }
    notifications.push({
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      relativePath: file.relativePath,
      runtimeEnvironmentId: target.runtimeEnvironmentId ?? null,
      ...getLocalWindowsWslAliasOption(target)
    })
  }
  return notifications
}
