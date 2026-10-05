import { useAppStore } from '@/store'
import { isExternalReloadableEditorTab } from '@/components/editor/editor-autosave'
import { relativePathInsideRoot } from '../../../shared/cross-platform-path'
import {
  getLocalWindowsWslAliasOption,
  getOpenFileRuntimeOwner,
  type EditorExternalWatchTarget
} from './editor-external-watch-targets'
import {
  scheduleEditorChangedOnDiskMark,
  type EditorExternalWatchNotification
} from './editor-external-watch-disk-verification'

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
    const relativePath = relativePathInsideRoot(target.worktreePath, file.filePath)
    if (
      relativePath === null ||
      relativePath === '' ||
      file.worktreeId !== target.worktreeId ||
      getOpenFileRuntimeOwner(file) !== (target.runtimeEnvironmentId ?? null) ||
      !isExternalReloadableEditorTab(file)
    ) {
      continue
    }
    const notification: EditorExternalWatchNotification = {
      worktreeId: target.worktreeId,
      worktreePath: target.worktreePath,
      relativePath,
      runtimeEnvironmentId: target.runtimeEnvironmentId ?? null,
      ...getLocalWindowsWslAliasOption(target)
    }
    if (file.isDirty) {
      scheduleEditorChangedOnDiskMark(
        { ...notification, connectionId: target.connectionId },
        notification,
        [file.id]
      )
      continue
    }
    if (file.externalMutation) {
      state.setExternalMutation(file.id, null)
    }
    notifications.push(notification)
  }
  return notifications
}
